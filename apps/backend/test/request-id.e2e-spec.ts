import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { REQUEST_ID_HEADER } from '../src/observability/request-context';

/**
 * The request id, from the API's side of the wire.
 *
 * Boots AppModule because the middleware is registered in its `configure()` —
 * a narrower graph would test an app without it, the same reasoning the global
 * ValidationPipe already forced in app.module.ts.
 *
 * Run with `pnpm db:test` from the repo root: /conversations needs a real
 * database, and the credentials only Compose's env_file supplies.
 */
describe('request id propagation (e2e)', () => {
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

  it('mints an id when the caller supplies none', async () => {
    const response = await request(app.getHttpServer())
      .get('/conversations?page=1&pageSize=1')
      .set('x-org-id', '1')
      .expect(200);

    // A v4 UUID: the fallback shape, and safe to embed in a SQL comment.
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed inbound id unchanged', async () => {
    const response = await request(app.getHttpServer())
      .get('/conversations?page=1&pageSize=1')
      .set('x-org-id', '1')
      .set(REQUEST_ID_HEADER, 'drill06-from-the-edge')
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toBe('drill06-from-the-edge');
  });

  /**
   * The one that matters.
   *
   * PostgresService interpolates this value into a SQL comment, so an id that
   * can close the comment is an injection. `pg` sends param-less queries over
   * the simple protocol, where `;`-separated statements are legal — so this is
   * reachable, not theoretical. The fix is an allowlist, not escaping: anything
   * outside [A-Za-z0-9_-]{8,64} is replaced with a fresh id rather than
   * sanitised into something almost-safe.
   *
   * Note what is *not* tested here: a newline-bearing id. Node's HTTP client
   * refuses to send one (ERR_INVALID_CHAR) and its server refuses to parse one,
   * so log injection via this header is already unreachable over HTTP. The
   * allowlist is the layer that does not depend on that staying true.
   */
  it.each([
    ['closes the SQL comment', '*/ SELECT 1; --'],
    ['smuggles quotes', "abcdefgh' OR 1=1"],
    ['is too short to be meaningful', 'short'],
    ['is too long to be a bounded field', 'x'.repeat(65)],
  ])('replaces an id that %s', async (_why, hostile) => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set(REQUEST_ID_HEADER, hostile);

    const echoed = response.headers[REQUEST_ID_HEADER];
    expect(echoed).not.toBe(hostile);
    expect(echoed).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('carries an id on a request that never reaches a handler', async () => {
    // 404s and ValidationPipe 400s are exactly the responses worth correlating,
    // and neither reaches the interceptor — which is why the header is set in
    // middleware.
    const missing = await request(app.getHttpServer())
      .get('/no-such-route')
      .expect(404);
    expect(missing.headers[REQUEST_ID_HEADER]).toBeDefined();

    const rejected = await request(app.getHttpServer())
      .get('/conversations?page=-1')
      .set('x-org-id', '1')
      .expect(400);
    expect(rejected.headers[REQUEST_ID_HEADER]).toBeDefined();
  });
});
