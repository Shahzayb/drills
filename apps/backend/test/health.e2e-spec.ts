import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { HealthReport } from '../src/health/health.service';
import { POOL_MAX, PostgresService } from '../src/postgres/postgres.service';

/**
 * Drill 23's follow-up. With every pool connection held, as on an overloaded replica, readiness must
 * still answer: it routes traffic, and a timed-out check took the last replica out. `db:test:readydeps`
 * (READINESS=deps) fails the first test. See plans/2026-10-11_drill-23-graceful-shutdown.md.
 */
describe('GET /health under a saturated pool (e2e)', () => {
  let app: INestApplication<App>;
  let ready: Response;
  let readyMs = 0;
  let deps: Response;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const postgres = app.get(PostgresService);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = Array.from({ length: POOL_MAX }, () =>
      postgres.withClient(() => gate),
    );
    while (postgres.stats().total < POOL_MAX || postgres.stats().idle > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const startedAt = performance.now();
    ready = await request(app.getHttpServer()).get('/health');
    readyMs = performance.now() - startedAt;
    deps = await request(app.getHttpServer()).get('/health/deps');

    release();
    await Promise.all(held);
  }, 15_000);

  afterAll(async () => {
    await app.close();
  });

  it('answers readiness from local state, without waiting for the pool', () => {
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok' });
    expect(readyMs).toBeLessThan(500);
  });

  it('reports the saturated pool on /health/deps', () => {
    const body = deps.body as HealthReport;
    expect(deps.status).toBe(503);
    expect(body.checks?.postgres.status).toBe('down');
    expect(body.checks?.redis.status).toBe('up');
  });
});
