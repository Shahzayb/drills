import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ImportJob } from '../src/imports/imports.service';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 15's proof for `POST /imports`: real HTTP, a real CSV body, a real
 * Postgres. Nothing is mocked, because the two properties this exists to show —
 * a batch being one transaction, and a unique index making a re-import a no-op —
 * are both properties of the running database.
 *
 * Files here are hundreds of rows, not 200MB. The mechanism is size-independent;
 * the card's literal file lives in `pnpm db:import fire`, which is the right
 * shape for a measurement and the wrong shape for a suite that has to stay fast.
 *
 * Two arms, and only one of them is expected to fail:
 *
 *   pnpm db:test:buffer    IMPORT=buffer          4 failures, and they are the
 *                          deliverable: the request is answered LATE, one
 *                          upload spends a query per row instead of one, the
 *                          durable state after a crash is an ARBITRARY row
 *                          rather than a batch boundary, and a retry answers
 *                          500 rather than 202 because the work it does
 *                          synchronously is what throws. The plan predicted
 *                          three; the retry is the one it missed.
 *   pnpm db:test:restart   IMPORT_ON_FAIL=restart GREEN. Restarting from row
 *                          zero is slower and just as correct, because the
 *                          unique index makes every re-inserted row a no-op.
 *                          A red arm that is expected to pass is unusual here
 *                          and it is the point: both answers work.
 *
 * See plans/2026-09-09_drill-15-streaming-csv-import.md.
 */
describe('POST /imports (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;

  const tag = `import-e2e-${Date.now()}`;

  let orgId: string;
  let otherOrgId: string;

  // Above one batch of the default 1000? No — deliberately below it, so a whole
  // file is a handful of transactions and the suite stays quick. The poisoned
  // case below overrides the batch size instead, which is the only place the
  // boundary has to be crossed.
  const ROWS = 250;

  const HEADER = 'external_id,status,created_at,updated_at,subject,message\n';

  /**
   * A CSV of `rows` records. Row `poisonAt` gets a timestamp Postgres cannot
   * parse, so the failure is the database's 22007 and not an exception this
   * file invented.
   *
   * Every fifth message is quoted and carries a comma and a newline. A line
   * splitter passes every other assertion in this suite and fails on those.
   */
  const csv = (prefix: string, rows: number, poisonAt = 0): string => {
    const lines = [HEADER];
    for (let i = 1; i <= rows; i++) {
      const created =
        i === poisonAt ? 'not-a-timestamp' : '2024-03-04T09:30:00.000Z';
      const message =
        i % 5 === 0
          ? `"line one, with a comma\nline two"`
          : `imported message ${i}`;
      lines.push(
        `${prefix}-${i},${i % 2 ? 'open' : 'closed'},${created},` +
          `2024-03-05T14:15:00.000Z,"Ticket ${i}, imported",${message}\n`,
      );
    }
    return lines.join('');
  };

  const upload = (body: string, org = orgId) =>
    request(app.getHttpServer())
      .post('/imports')
      .set('x-org-id', org)
      .set('content-type', 'text/csv')
      .set('x-filename', 'history.csv')
      .send(body);

  const job = (id: string, org = orgId) =>
    request(app.getHttpServer()).get(`/imports/${id}`).set('x-org-id', org);

  const jobs = (org = orgId) =>
    request(app.getHttpServer()).get('/imports').set('x-org-id', org);

  /** Poll until the worker stops. The streaming arm answers before it starts,
   *  so every assertion about rows has to wait for something. */
  const settle = async (id: string): Promise<ImportJob> => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const body = (await job(id).expect(200)).body as ImportJob;
      if (body.status === 'succeeded' || body.status === 'failed') return body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`import ${id} never finished`);
  };

  /** The newest job for this org. Used where the upload's own response cannot
   *  be trusted to carry an id — the buffered arm answers 500 when the import
   *  it performed inline threw. */
  const newest = async (): Promise<ImportJob> =>
    ((await jobs().expect(200)).body as ImportJob[])[0];

  const imported = (prefix: string) =>
    tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM conversations
          WHERE org_id = $1::bigint AND provider_event_id LIKE $2`,
        [orgId, `import:${prefix}-%`],
      );
      return Number(rows[0].n);
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // listen(0), not init(): supertest starts a fresh ephemeral server per
    // request for an app that is not listening, and a streamed body against one
    // of those is a different code path from the one that ships.
    await app.listen(0);

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);

    const orgs = await db.query<{ id: string; name: string }>(
      `INSERT INTO organizations (name, plan)
       VALUES ($1, 'pro'), ($2, 'free')
       RETURNING id, name`,
      [`${tag}-org`, `${tag}-other-org`],
    );
    const byName = new Map(orgs.rows.map((row) => [row.name, row.id]));
    orgId = byName.get(`${tag}-org`)!;
    otherOrgId = byName.get(`${tag}-other-org`)!;
  });

  afterAll(async () => {
    if (orgId) {
      // One scope per org: a policy filters per row against a single current
      // tenant, so a combined WHERE would clean one org and leave the other.
      for (const id of [orgId, otherOrgId]) {
        await tenants.withOrg(id, async (tx) => {
          await tx.query(`DELETE FROM import_jobs WHERE org_id = $1::bigint`, [
            id,
          ]);
          await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [
            id,
          ]);
          await tx.query(
            `DELETE FROM conversations WHERE org_id = $1::bigint`,
            [id],
          );
        });
      }
      await db.query(`DELETE FROM organizations WHERE id = ANY($1::bigint[])`, [
        [orgId, otherOrgId],
      ]);
    }
    await app.close();
  });

  describe('the happy path', () => {
    let created: ImportJob;

    beforeAll(async () => {
      const response = await upload(csv('happy', ROWS));
      created = response.body as ImportJob;
      // Asserted inside the test below rather than here, so a wrong status code
      // is one named failure instead of a whole block erroring out.
      await settle(created.id);
    }, 60_000);

    // FAILS on IMPORT=buffer, which answers 200 only once every row has landed.
    // That is the card's "holds an HTTP request open for forty minutes" as an
    // assertion.
    it('answers 202 with a job id before the work is done', () => {
      expect(created.id).toEqual(expect.any(String));
      expect(created.status).toBe('pending');
    });

    it('imports every row exactly once', async () => {
      const finished = await settle(created.id);

      expect(finished.status).toBe('succeeded');
      expect(finished.rowsRead).toBe(ROWS);
      expect(finished.rowsWritten).toBe(ROWS);
      expect(finished.rowsSkipped).toBe(0);
      expect(await imported('happy')).toBe(ROWS);
    });

    // The quoted bodies. A line splitter reads those as two records and lands
    // more rows than the file has, which the count above would catch — this
    // asserts the content rather than the arithmetic.
    it('keeps a quoted field with a comma and a newline intact', async () => {
      const { rows } = await tenants.withOrg(orgId, (tx) =>
        tx.query<{ message: string }>(
          `SELECT m.message FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
            WHERE c.provider_event_id = $1`,
          ['import:happy-5'],
        ),
      );

      expect(rows[0].message).toBe('line one, with a comma\nline two');
    });

    // Drill 12's partial unique index, doing a job it was not built for. This
    // is what makes "restart from row zero" a correct answer.
    it('writes nothing new when the same file is imported again', async () => {
      const again = (await upload(csv('happy', ROWS))).body as ImportJob;
      const finished = await settle(again.id);

      expect(finished.status).toBe('succeeded');
      expect(finished.rowsWritten).toBe(0);
      expect(finished.rowsSkipped).toBe(ROWS);
      expect(await imported('happy')).toBe(ROWS);
    }, 60_000);

    // FAILS on IMPORT=buffer at one query per row. The counter is drill 08's
    // and the header is what QUERY_COUNTER=header turns on for the suite.
    it('spends one statement on the upload itself', async () => {
      const response = await upload(csv('budget', 10));
      await settle((response.body as ImportJob).id);

      expect(response.headers['x-query-count']).toBe('1');
    }, 60_000);
  });

  describe('when it fails half way', () => {
    // 2,500 rows with the poison at 1,500. At the default batch of 1,000 the
    // first batch commits, the second dies, and the boundary is 1,000 — a
    // number neither the file nor the error mentions, which is exactly why it
    // has to be stored rather than derived.
    const POISON_AT = 1500;
    const TOTAL = 2500;

    let failed: ImportJob;

    beforeAll(async () => {
      await upload(csv('poison', TOTAL, POISON_AT));
      const latest = await newest();
      failed = await settle(latest.id);
    }, 60_000);

    it('marks the job failed and names the row', () => {
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/row \d+/);
    });

    // The whole answer to "the import fails at row 400,000, what's the state".
    // resume_row is written by the same transaction as the rows it counts, so
    // it cannot name a row that is not durable.
    it('leaves exactly resume_row rows in the database', async () => {
      expect(await imported('poison')).toBe(failed.resumeRow);
    });

    // FAILS on IMPORT=buffer, which commits one row at a time and therefore
    // stops wherever the poison happens to be. A durable state that is a batch
    // boundary is a property of batching, not of importing.
    it('stops on a batch boundary', () => {
      expect(failed.resumeRow % failed.batchRows).toBe(0);
      expect(failed.resumeRow).toBeLessThan(POISON_AT);
    });

    // A retry is not a repair, and saying so out loud is half the deliverable.
    it('fails again at the same row on a retry, without double-writing', async () => {
      const before = await imported('poison');

      await request(app.getHttpServer())
        .post(`/imports/${failed.id}/retry`)
        .set('x-org-id', orgId)
        .expect(202);

      const again = await settle(failed.id);

      expect(again.status).toBe('failed');
      expect(again.resumeRow).toBe(failed.resumeRow);
      expect(await imported('poison')).toBe(before);
    }, 60_000);

    // The other half: fix the data, upload it again, and only the rows that
    // were missing land. True on both IMPORT_ON_FAIL arms, which is why
    // db:test:restart is expected green.
    it('completes when the fixed file is imported', async () => {
      const stalled = await imported('poison');

      const clean = (await upload(csv('poison', TOTAL))).body as ImportJob;
      const finished = await settle(clean.id);

      expect(finished.status).toBe('succeeded');
      expect(finished.rowsSkipped).toBe(stalled);
      expect(finished.rowsWritten).toBe(TOTAL - stalled);
      expect(await imported('poison')).toBe(TOTAL);
    }, 60_000);
  });

  describe('tenancy', () => {
    it('does not show one org another org’s job', async () => {
      const mine = (await upload(csv('tenancy', 5))).body as ImportJob;
      await settle(mine.id);

      await job(mine.id, otherOrgId).expect(404);
    }, 60_000);

    it('rejects an upload with no org header', async () => {
      await request(app.getHttpServer())
        .post('/imports')
        .set('content-type', 'text/csv')
        .send(csv('noorg', 2))
        .expect(400);
    });

    it('400s on a malformed job id rather than 500ing', async () => {
      await job('not-a-uuid').expect(400);
    });
  });
});
