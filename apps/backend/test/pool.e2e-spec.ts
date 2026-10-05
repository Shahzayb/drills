import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { InfoResponse } from '../src/info/info.controller';
import { PostgresService } from '../src/postgres/postgres.service';

/**
 * Card 22's acquire-wait metric. Saturating the pool must show up as waits, at the pool size `/info`
 * reports, which is also the proof that `PG_POOL_MAX` reaches the pool: `db:test:pool2` stays green.
 * See plans/2026-10-06_drill-22-connection-pool-knee.md.
 */
describe('connection pool metrics (e2e)', () => {
  let app: INestApplication<App>;
  let postgres: PostgresService;

  const HOLD_S = 0.2;

  /** One histogram's `_count`, and how many observations were above `le`. */
  const histogram = async (name: string, le: string) => {
    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    const read = (series: string) =>
      Number(
        response.text
          .split('\n')
          .find((line) => line.startsWith(`${series} `))
          ?.split(' ')[1],
      );
    const count = read(`${name}_count`);
    return { count, above: count - read(`${name}_bucket{le="${le}"}`) };
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    postgres = app.get(PostgresService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('records a wait for every acquire past the pool size', async () => {
    const info = await request(app.getHttpServer()).get('/info').expect(200);
    const max = Number((info.body as InfoResponse).arms.poolMax);

    const waitBefore = await histogram('pg_pool_acquire_wait_seconds', '0.1');
    const holdBefore = await histogram('pg_pool_hold_seconds', '0.1');

    await Promise.all(
      Array.from({ length: 2 * max }, () =>
        postgres.withClient((client) =>
          client.query('SELECT pg_sleep($1)', [HOLD_S]),
        ),
      ),
    );

    const waitAfter = await histogram('pg_pool_acquire_wait_seconds', '0.1');
    const holdAfter = await histogram('pg_pool_hold_seconds', '0.1');

    // The first `max` get a connection at once; the second `max` queue behind a 200ms hold.
    expect(waitAfter.count - waitBefore.count).toBe(2 * max);
    expect(waitAfter.above - waitBefore.above).toBeGreaterThanOrEqual(max);
    expect(holdAfter.above - holdBefore.above).toBe(2 * max);
  });

  it('reports per-request pool time in header mode', async () => {
    const response = await request(app.getHttpServer())
      .get('/info')
      .expect(200);

    expect(Number(response.headers['x-pool-wait-ms'])).toBeGreaterThanOrEqual(
      0,
    );
    expect(Number(response.headers['x-pool-hold-ms'])).toBeGreaterThan(0);
  });
});
