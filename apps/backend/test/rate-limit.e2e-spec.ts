import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  type Entitlements,
  EntitlementsService,
  RATE_LIMIT,
  rateLimitKey,
} from '../src/entitlements/entitlements.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Card 21's two attacks, in process, against the running arm. A free plan: 60 per minute, so a bucket
 * holds 60 and refills 1/s. Red runs: `db:test:fixed` fails the boundary test, `db:test:bucketrmw`
 * the concurrent one, `db:test:fixedrmw` both.
 * See plans/2026-10-06_drill-21-rate-limit-burst-boundary.md.
 */
describe(`rate limit (e2e, arm: ${RATE_LIMIT})`, () => {
  let app: INestApplication<App>;
  let limiter: EntitlementsService;
  let redis: RedisService;

  const LIMIT = 60;
  const FREE: Entitlements = {
    plan: 'free',
    ingestPerMinute: LIMIT,
    loadedAt: Date.now(),
  };
  const tag = `rate-limit-e2e-${Date.now()}`;
  const orgs = { concurrent: `${tag}-concurrent`, boundary: `${tag}-boundary` };

  const take = (org: string) => limiter.consumeIngest(org, FREE);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    limiter = app.get(EntitlementsService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    for (const org of Object.values(orgs)) await redis.del(rateLimitKey(org));
    await app.close();
  });

  it('admits the limit, and no more, to 200 concurrent requests', async () => {
    const startedAt = Date.now();
    const decisions = await Promise.all(
      Array.from({ length: 200 }, () => take(orgs.concurrent)),
    );
    const refilled = Math.ceil((Date.now() - startedAt) / 1000);
    const admitted = decisions.filter((decision) => decision?.allowed).length;

    // On an rmw arm every GET is on the socket before the first SET, so all 200 read a full limit.
    expect(admitted).toBeGreaterThanOrEqual(LIMIT);
    expect(admitted).toBeLessThanOrEqual(LIMIT + refilled);
  });

  it('admits only what refilled to a burst right after the boundary', async () => {
    const startedAt = Date.now();
    for (let i = 0; i < LIMIT; i++) {
      expect((await take(orgs.boundary))?.allowed).toBe(true);
    }

    // A fixed window's only clock is its key's expiry: deleting the key is the boundary, without the 60s wait.
    if (RATE_LIMIT === 'fixed' || RATE_LIMIT === 'fixed-rmw') {
      await redis.del(rateLimitKey(orgs.boundary));
    }

    let admitted = 0;
    for (let i = 0; i < LIMIT; i++) {
      if ((await take(orgs.boundary))?.allowed) admitted += 1;
    }
    const refilled = Math.ceil((Date.now() - startedAt) / 1000);

    expect(admitted).toBeLessThanOrEqual(refilled);
  });
});
