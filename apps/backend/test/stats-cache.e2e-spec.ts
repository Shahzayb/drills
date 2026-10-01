import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PostgresService } from '../src/postgres/postgres.service';
import { RedisService } from '../src/redis/redis.service';
import { STATS_TTL_S, statsKey } from '../src/search/search.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 20's DONE WHEN as a test: an expired hot key costs Postgres one recompute, not one per
 * concurrent request. Expectations follow `process.env.STATS_CACHE`, not the module constant, so
 * a switch that stops switching disagrees with the shell and fails.
 *
 * Red runs: `db:test:stampede` (`naive`) fails the two burst tests; `db:test:nojitter` fails the
 * spread test. `db:test:statswait` is green. See plans/2026-09-29_drill-20-cache-stampede.md.
 */
const ARM = ['off', 'naive', 'wait', 'stale'].includes(
  process.env.STATS_CACHE ?? '',
)
  ? process.env.STATS_CACHE!
  : 'stale';

const BURST = 30;

interface Envelope {
  computedAt: number;
  freshUntil: number;
}

describe('stats cache (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;
  let redis: RedisService;

  const tag = `stats-cache-e2e-${Date.now()}`;
  let orgId: string;
  const spreadOrgs: string[] = [];

  const stats = (org: string) =>
    request(app.getHttpServer()).get('/messages/stats').set('x-org-id', org);

  const recomputes = async (): Promise<number> => {
    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    return Number(/^stats_recomputes_total (\d+)$/m.exec(response.text)![1]);
  };

  const burst = async (org: string) => {
    const before = await recomputes();
    const responses = await Promise.all(
      Array.from({ length: BURST }, () => stats(org).expect(200)),
    );
    const sources = responses.map((r) => r.headers['x-stats-cache']);
    const count = (source: string) =>
      sources.filter((s) => s === source).length;
    return {
      responses,
      sources,
      count,
      recomputed: (await recomputes()) - before,
    };
  };

  const envelope = async (org: string) =>
    JSON.parse((await redis.get(statsKey(org)))!) as Envelope;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // listen(0): thirty supertest requests against an app that is not listening each start their
    // own ephemeral server, and fail in the client (drill 12).
    await app.listen(0);

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);
    redis = app.get(RedisService);

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, plan)
       SELECT $1 || '-' || n, 'pro' FROM generate_series(0, 20) AS n
       RETURNING id`,
      [tag],
    );
    orgId = rows[0].id;
    spreadOrgs.push(...rows.slice(1).map((row) => row.id));

    await tenants.withOrg(orgId, async (tx) => {
      const conversation = await tx.query<{ id: string }>(
        `INSERT INTO conversations (org_id, status) VALUES ($1::bigint, 'open') RETURNING id`,
        [orgId],
      );
      await tx.query(
        `INSERT INTO messages (conversation_id, org_id, message)
         SELECT $1::uuid, $2::bigint, 'the export failed again, message ' || n
           FROM generate_series(1, 200) AS n`,
        [conversation.rows[0].id, orgId],
      );
    });
  });

  afterAll(async () => {
    if (orgId) {
      await tenants.withOrg(orgId, async (tx) => {
        await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [
          orgId,
        ]);
        await tx.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [
          orgId,
        ]);
      });
      const all = [orgId, ...spreadOrgs];
      await db.query(`DELETE FROM organizations WHERE id = ANY($1::bigint[])`, [
        all,
      ]);
      for (const id of all) await redis.del(statsKey(id));
    }
    await app.close();
  });

  it('a cold key under a burst costs one recompute', async () => {
    await redis.del(statsKey(orgId));

    const { count, recomputed } = await burst(orgId);

    expect(recomputed).toBe(1);
    expect(count('miss')).toBe(1);
    expect(count('miss') + count('wait') + count('hit')).toBe(BURST);
  });

  it('an expired key under a burst costs one recompute', async () => {
    await stats(orgId).expect(200);
    const old = await envelope(orgId);
    // What db/stampede.mts does to force an expiry: the value stays, its freshness ends now.
    await redis.set(
      statsKey(orgId),
      JSON.stringify({ ...old, freshUntil: 0 }),
      60,
    );

    const { responses, count, recomputed } = await burst(orgId);
    expect(recomputed).toBe(1);

    if (ARM === 'stale') {
      expect(count('refresh')).toBe(1);
      expect(count('refresh') + count('stale') + count('hit')).toBe(BURST);
      const servedOld = responses.filter((r) =>
        ['refresh', 'stale'].includes(r.headers['x-stats-cache']),
      );
      for (const r of servedOld) {
        expect(Date.parse(r.headers['x-served-at'])).toBe(old.computedAt);
      }
      // The refresh runs after the response. The next reader gets its value.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = await stats(orgId).expect(200);
      expect(after.headers['x-stats-cache']).toBe('hit');
      expect(Date.parse(after.headers['x-served-at'])).toBeGreaterThan(
        old.computedAt,
      );
    } else {
      expect(count('miss')).toBe(1);
      expect(count('miss') + count('wait') + count('hit')).toBe(BURST);
      const bodies = new Set(responses.map((r) => r.headers['x-served-at']));
      expect(bodies.size).toBe(1);
    }
  });

  it('releases a lock only for the holder that took it', async () => {
    const lock = `lock:test:${tag}`;
    expect(await redis.setIfAbsent(lock, 'holder-a', 10)).toBe(true);
    // Holder a's lock expired and b took it: a's late release must not free b's lock.
    await redis.set(lock, 'holder-b', 10);

    expect(await redis.delIfEquals(lock, 'holder-a')).toBe(false);
    expect(await redis.get(lock)).toBe('holder-b');
    expect(await redis.delIfEquals(lock, 'holder-b')).toBe(true);
    expect(await redis.get(lock)).toBeNull();
  });

  // Twenty keys filled in the same second must not expire in the same second. Jitter off, the
  // windows are all equal; at the default 0.2 their spread is ~18% of the TTL.
  (ARM === 'off' ? it.skip : it)(
    'spreads the freshness of keys filled together',
    async () => {
      for (const id of spreadOrgs) await redis.del(statsKey(id));
      await Promise.all(spreadOrgs.map((id) => stats(id).expect(200)));

      const windows = await Promise.all(
        spreadOrgs.map(async (id) => {
          const { computedAt, freshUntil } = await envelope(id);
          return freshUntil - computedAt;
        }),
      );
      const ttlMs = STATS_TTL_S * 1000;
      expect(Math.max(...windows)).toBeLessThanOrEqual(ttlMs);
      expect(Math.max(...windows) - Math.min(...windows)).toBeGreaterThan(
        ttlMs * 0.05,
      );
    },
  );

  it('Cache-Control: no-cache bypasses a fresh key', async () => {
    await stats(orgId).expect(200);

    const response = await stats(orgId)
      .set('cache-control', 'no-cache')
      .expect(200);

    expect(response.headers['x-stats-cache']).toBe('bypass');
    expect(Number(response.headers['x-query-count'])).toBe(1);
  });

  (ARM === 'off' ? it.skip : it)(
    'a hit says when Postgres computed it',
    async () => {
      await redis.del(statsKey(orgId));
      await stats(orgId).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const askedAt = Date.now();
      const response = await stats(orgId).expect(200);

      expect(response.headers['x-stats-cache']).toBe('hit');
      expect(Date.parse(response.headers['x-served-at'])).toBeLessThan(askedAt);
    },
  );
});
