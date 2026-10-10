import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Agent,
  IncomingMessage,
  Server,
  request as httpRequest,
} from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DRAIN_DELAY_MS, HealthService } from '../src/health/health.service';
import {
  IMPORT_BATCH_ROWS,
  ImportJob,
  ImportsService,
} from '../src/imports/imports.service';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 23. The hooks are called with a signal directly: `app.close()` is typed without one, and the
 * drain runs only for a signal. Every test boots its own app because a drain is one-way.
 * `db:test:nodrain` (SHUTDOWN=nest) fails all four. See plans/2026-10-11_drill-23-graceful-shutdown.md.
 */
describe('graceful shutdown (e2e)', () => {
  const tag = `shutdown-e2e-${Date.now()}`;
  // Kept for setup and cleanup. Each drain boots and closes its own app, so the suite holds one extra
  // app at a time inside the dev container's 1GB.
  let main: INestApplication<App>;
  let orgId: string;

  const boot = async (): Promise<INestApplication<App>> => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.listen(0);
    return app;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Bounded, so the red arm fails the assertion after it instead of hanging the suite. */
  const waitFor = async (done: () => boolean, ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (!done() && Date.now() < until) await sleep(10);
  };

  beforeAll(async () => {
    main = await boot();
    const { rows } = await main.get(PostgresService).query<{
      id: string;
    }>(`INSERT INTO organizations (name, plan) VALUES ($1, 'pro') RETURNING id`, [`${tag}-org`]);
    orgId = rows[0].id;
  });

  afterAll(async () => {
    await main.get(TenantDb).withOrg(orgId, async (tx) => {
      await tx.query(`DELETE FROM import_jobs WHERE org_id = $1::bigint`, [
        orgId,
      ]);
      await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [orgId]);
      await tx.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [
        orgId,
      ]);
    });
    await main
      .get(PostgresService)
      .query(`DELETE FROM organizations WHERE id = $1::bigint`, [orgId]);
    await main.close();
  });

  it('answers readiness 503 and liveness 200 while draining', async () => {
    const app = await boot();
    const drained = app.get(HealthService).beforeApplicationShutdown('SIGTERM');

    const ready = await request(app.getHttpServer()).get('/health');
    const live = await request(app.getHttpServer()).get('/health/live');
    await drained;
    await app.close();

    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'draining' });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'ok', phase: 'draining' });
  }, 30_000);

  describe('a request in flight when the listener closes', () => {
    let response: IncomingMessage;
    let bodySentAt = 0;
    let drainedAt = 0;
    let socketClosed = false;

    beforeAll(async () => {
      const app = await boot();
      const health = app.get(HealthService);
      const server = app.getHttpServer() as unknown as Server;
      const { port } = server.address() as AddressInfo;
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });

      // A first request leaves a kept-alive socket; the upload below reuses it.
      await new Promise<void>((resolve) =>
        httpRequest({ port, agent, path: '/health/live' }, (res) => {
          res.resume().on('end', resolve);
        }).end(),
      );

      const upload = httpRequest({
        port,
        agent,
        method: 'POST',
        path: '/imports',
        headers: {
          'x-org-id': orgId,
          'content-type': 'text/csv',
          'x-filename': 'inflight.csv',
        },
      });
      const answered = new Promise<IncomingMessage>((resolve) =>
        upload.on('response', (res) => {
          res.socket.once('close', () => (socketClosed = true));
          res.resume().on('end', () => resolve(res));
        }),
      );
      upload.write(
        'external_id,status,created_at,updated_at,subject,message\n',
      );

      const drained = health
        .beforeApplicationShutdown('SIGTERM')
        .then(() => (drainedAt = performance.now()));
      await waitFor(
        () => health.snapshot().phase === 'closing',
        DRAIN_DELAY_MS + 2000,
      );

      bodySentAt = performance.now();
      upload.end(
        'inflight-1,open,2024-03-04T09:30:00Z,2024-03-04T09:30:00Z,s,m\n',
      );
      response = await answered;
      await drained;
      await waitFor(() => socketClosed, 1000);
      await app.close();
    }, 30_000);

    it('finishes it with Connection: close', () => {
      expect(response.statusCode).toBe(202);
      expect(response.headers.connection).toBe('close');
      expect(socketClosed).toBe(true);
    });

    it('waits for it before the drain resolves', () => {
      // The server cannot answer before the body ends, so a drain that waited resolves after it.
      expect(drainedAt).toBeGreaterThan(bodySentAt);
    });
  });

  it('stops a running import at a batch boundary, and a retry lands every row once', async () => {
    const ROWS = 30_000;
    const lines = [
      'external_id,status,created_at,updated_at,subject,message\n',
    ];
    for (let i = 1; i <= ROWS; i++) {
      lines.push(
        `drain-${i},open,2024-03-04T09:30:00Z,2024-03-05T14:15:00Z,s,m ${i}\n`,
      );
    }

    const first = await boot();
    const created = (
      await request(first.getHttpServer())
        .post('/imports')
        .set('x-org-id', orgId)
        .set('content-type', 'text/csv')
        .set('x-filename', 'drain.csv')
        .send(lines.join(''))
        .expect(202)
    ).body as ImportJob;

    const read = async (app: INestApplication<App>) =>
      (
        await request(app.getHttpServer())
          .get(`/imports/${created.id}`)
          .set('x-org-id', orgId)
          .expect(200)
      ).body as ImportJob;

    let job = await read(first);
    for (let i = 0; i < 500 && job.resumeRow < IMPORT_BATCH_ROWS; i++) {
      await sleep(10);
      job = await read(first);
    }
    await first.get(ImportsService).beforeApplicationShutdown('SIGTERM');
    const stopped = await read(first);
    await first.close();

    const second = await boot();
    await request(second.getHttpServer())
      .post(`/imports/${created.id}/retry`)
      .set('x-org-id', orgId)
      .expect(202);
    let finished = await read(second);
    for (let i = 0; i < 1500 && finished.status !== 'succeeded'; i++) {
      await sleep(20);
      finished = await read(second);
    }
    await second.close();

    expect(stopped.status).toBe('failed');
    expect(stopped.error).toContain('interrupted by shutdown');
    expect(stopped.resumeRow % IMPORT_BATCH_ROWS).toBe(0);
    expect(stopped.resumeRow).toBeGreaterThan(0);
    expect(stopped.resumeRow).toBeLessThan(ROWS);
    expect(finished.status).toBe('succeeded');
    expect(finished.rowsWritten + finished.rowsSkipped).toBe(ROWS);
    expect(finished.rowsWritten).toBe(ROWS);
  }, 60_000);
});
