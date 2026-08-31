import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { InfoResponse } from '../src/info/info.controller';

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

  it('sees the arm the test script sets in the shell', async () => {
    const response = await request(app.getHttpServer())
      .get('/info')
      .expect(200);
    const body = response.body as InfoResponse;
    expect(body.arms.queryCounter).toBe('header');
  });
});
