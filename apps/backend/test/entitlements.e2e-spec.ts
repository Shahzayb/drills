import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { EntitlementsResponse } from '../src/entitlements/entitlements.controller';
import {
  ENTITLEMENT_CACHE,
  ENTITLEMENT_TTL_S,
  entitlementKey,
} from '../src/entitlements/entitlements.service';
import { API_KEY_PREFIX, hashApiKey } from '../src/ingest/api-key.guard';
import { PostgresService } from '../src/postgres/postgres.service';
import { RedisService } from '../src/redis/redis.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 19's DONE WHEN as a test: a plan change is visible inside a stated bound.
 * Runs at ENTITLEMENT_TTL_S=2 (apps/backend/package.json) so the out-of-band case waits ≤2s.
 * Red runs: `db:test:nocache` fails the hit test, `db:test:ttlonly` fails both API-path tests.
 * See plans/2026-09-23_drill-19-entitlement-cache.md.
 */
describe('entitlements (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;
  let redis: RedisService;

  const tag = `entitlements-e2e-${Date.now()}`;
  const key = `${API_KEY_PREFIX}${tag}`;
  const names = ['cache', 'api', 'limit', 'oob', 'metrics'] as const;
  const org = {} as Record<(typeof names)[number], string>;
  const unknownOrg = String(9_000_000_000 + Math.floor(Math.random() * 1e6));

  /** The out-of-band bound per arm. `ttl`/`invalidate` wait out the TTL; `notify` hears the trigger. */
  const OOB_BOUND_MS =
    ENTITLEMENT_CACHE === 'off'
      ? 0
      : ENTITLEMENT_CACHE === 'notify'
        ? 500
        : ENTITLEMENT_TTL_S * 1000 + 500;

  const lookup = async (orgId: string) => {
    const response = await request(app.getHttpServer())
      .get('/entitlements')
      .set('X-Org-Id', orgId)
      .expect(200);
    return {
      body: response.body as EntitlementsResponse,
      header: response.headers['x-entitlement'],
      queries: response.headers['x-query-count'],
    };
  };

  const ingest = (id: string) =>
    request(app.getHttpServer())
      .post('/ingest')
      .set('Authorization', `Bearer ${key}`)
      .send({ eventId: `${tag}-${id}`, message: 'over the limit?' });

  const lookups = async () => {
    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    const counts: Record<string, number> = {};
    for (const [, result, n] of response.text.matchAll(
      /^entitlement_lookups_total\{result="(\w+)"\} (\d+)$/gm,
    )) {
      counts[result] = Number(n);
    }
    return counts;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);
    redis = app.get(RedisService);

    for (const name of names) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
        [`${tag}-${name}`],
      );
      org[name] = rows[0].id;
    }

    await tenants.withOrg(org.limit, (tx) =>
      tx.query(
        `INSERT INTO api_keys (org_id, name, key_hash) VALUES ($1::bigint, 'limit', $2)`,
        [org.limit, hashApiKey(key)],
      ),
    );
  });

  afterAll(async () => {
    await tenants.withOrg(org.limit, async (tx) => {
      await tx.query(`DELETE FROM usage_events WHERE org_id = $1::bigint`, [
        org.limit,
      ]);
      await tx.query(`DELETE FROM usage_counters WHERE org_id = $1::bigint`, [
        org.limit,
      ]);
      await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [
        org.limit,
      ]);
      await tx.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [
        org.limit,
      ]);
      await tx.query(`DELETE FROM api_keys`);
    });
    const ids = Object.values(org);
    await db.query(`DELETE FROM organizations WHERE id = ANY($1::bigint[])`, [
      ids,
    ]);
    for (const id of [...ids, unknownOrg]) {
      await redis.del(entitlementKey(id));
    }
    await redis.del(`rl:v1:ingest:org:${org.limit}`);
    await app.close();
  });

  it('misses once, then hits, and the miss is not charged to the route', async () => {
    const first = await lookup(org.cache);
    const second = await lookup(org.cache);

    expect(first.header).toBe('miss');
    expect(second.header).toBe('hit');
    expect(second.body.plan).toBe('free');
    expect(first.queries).toBe('0');
  });

  it('shows an upgrade made through the API on the very next request', async () => {
    await lookup(org.api);
    expect((await lookup(org.api)).body.plan).toBe('free');

    const put = await request(app.getHttpServer())
      .put('/entitlements/plan')
      .set('X-Org-Id', org.api)
      .send({ plan: 'basic' })
      .expect(200);
    expect((put.body as EntitlementsResponse).plan).toBe('basic');

    // The bound for an API write is zero stale reads. On `ttl` this reads 'free'.
    expect((await lookup(org.api)).body.plan).toBe('basic');
  });

  it('stops answering 429 the moment the customer upgrades', async () => {
    for (let i = 1; i <= 60; i++) {
      const response = await ingest(`ok-${i}`).expect(201);
      if (i === 60) {
        expect(response.headers['x-ratelimit-limit']).toBe('60');
        expect(response.headers['x-ratelimit-remaining']).toBe('0');
      }
    }

    const limited = await ingest('over').expect(429);
    expect(limited.body).toMatchObject({ error: 'rate_limited', limit: 60 });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Warm the key right before the upgrade, so the `ttl` red run is stale on purpose, not by timing.
    await lookup(org.limit);
    await request(app.getHttpServer())
      .put('/entitlements/plan')
      .set('X-Org-Id', org.limit)
      .send({ plan: 'pro' })
      .expect(200);

    await ingest('after-upgrade').expect(201);
  });

  it(`sees an out-of-band write within ${OOB_BOUND_MS}ms (arm: ${ENTITLEMENT_CACHE})`, async () => {
    await lookup(org.oob);
    expect((await lookup(org.oob)).body.plan).toBe('free');

    // An admin tool writing straight to Postgres: nothing here calls the cache.
    await db.query(`UPDATE organizations SET plan = 'pro' WHERE id = $1`, [
      org.oob,
    ]);
    const wroteAt = Date.now();

    const staleReads: number[] = [];
    let plan = (await lookup(org.oob)).body.plan;
    while (plan !== 'pro' && Date.now() - wroteAt <= OOB_BOUND_MS + 1000) {
      staleReads.push(Date.now() - wroteAt);
      await new Promise((resolve) => setTimeout(resolve, 50));
      plan = (await lookup(org.oob)).body.plan;
    }
    const stalenessMs = Date.now() - wroteAt;

    expect(plan).toBe('pro');
    expect(stalenessMs).toBeLessThanOrEqual(OOB_BOUND_MS + 100);
    if (ENTITLEMENT_CACHE === 'ttl' || ENTITLEMENT_CACHE === 'invalidate') {
      // The gap is real, not a timing accident: the first read after the write is stale.
      expect(staleReads.length).toBeGreaterThan(0);
    }
  });

  it('exposes lookups on /metrics, one per request', async () => {
    const before = await lookups();
    for (let i = 0; i < 4; i++) await lookup(org.metrics);
    const after = await lookups();

    const delta = (result: string) =>
      (after[result] ?? 0) - (before[result] ?? 0);
    if (ENTITLEMENT_CACHE === 'off') {
      expect(delta('db')).toBe(4);
    } else {
      expect([delta('miss'), delta('hit')]).toEqual([1, 3]);
    }
  });

  it('caches an org that does not exist, so a bogus id costs one read per TTL', async () => {
    const first = await lookup(unknownOrg);
    const second = await lookup(unknownOrg);

    expect(second.body.plan).toBeNull();
    expect([first.header, second.header]).toEqual(
      ENTITLEMENT_CACHE === 'off' ? ['db', 'db'] : ['miss', 'hit'],
    );
  });
});
