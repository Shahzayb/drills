import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { InfoResponse } from '../src/info/info.controller';

/**
 * The test drill 08 asked for: a measurement-arm switch needs a test that fails
 * when it stops switching.
 *
 * `GET /info` reports the resolved module constants the request path branches
 * on. This asserts they agree with the environment the process was started in,
 * which is the one property the endpoint exists for. If the controller is ever
 * changed to re-read process.env, the two agree here and disagree in a
 * container started before the variable changed — so the assertion is written
 * against the arm the suite is actually running under, not against a literal.
 *
 * Two arms exercise it for free: `pnpm db:test` runs the defaults and
 * `pnpm db:test:naive` sets LIST_STRATEGY=naive.
 *
 * See plans/2026-08-30_instrument-hardening.md.
 */
describe('GET /info arms (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the arm each switch resolved to', async () => {
    const response = await request(app.getHttpServer())
      .get('/info')
      .expect(200);
    const body = response.body as InfoResponse;

    expect(body.arms).toEqual({
      listStrategy: process.env.LIST_STRATEGY === 'naive' ? 'naive' : 'batched',
      keysetTiebreak: process.env.KEYSET_TIEBREAK === 'off' ? 'off' : 'on',
      searchStrategy: process.env.SEARCH_STRATEGY === 'like' ? 'like' : 'fts',
      queryCounter:
        process.env.QUERY_COUNTER === 'off' ||
        process.env.QUERY_COUNTER === 'header'
          ? process.env.QUERY_COUNTER
          : 'on',
      logLevel: process.env.LOG_LEVEL ?? 'info',
      tracing: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'on' : 'off',
    });
  });

  // The suite runs under QUERY_COUNTER=header (apps/backend/package.json), so
  // this arm is set by the shell on every run and its value is not the default.
  // A run where it reads 'on' means the variable stopped arriving.
  it('sees the arm the test script sets in the shell', async () => {
    const response = await request(app.getHttpServer())
      .get('/info')
      .expect(200);
    const body = response.body as InfoResponse;
    expect(body.arms.queryCounter).toBe('header');
  });
});
