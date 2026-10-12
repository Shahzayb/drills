import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppModule } from '../src/app.module';
import {
  type Entitlements,
  EntitlementsService,
  RATE_LIMIT,
  rateLimitKey,
} from '../src/entitlements/entitlements.service';
import {
  JOB,
  JOB_GRACE_S,
  JOB_SLOT_S,
  JobsService,
  LEASE_KEY,
  SCHEDULER,
} from '../src/jobs/jobs.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Card 24: three AppModules in one process are three module graphs, so three replicas sharing one
 * Postgres and one Redis. Each test drives `tick(now)` on a historic slot with a known ledger.
 * Red runs: `db:test:jobsall` fails 3, `db:test:lease` 2, `db:test:ratememory` 1.
 * See plans/2026-10-12_drill-24-three-replicas.md.
 */
describe(`three replicas (e2e, scheduler: ${SCHEDULER}, rate limit: ${RATE_LIMIT})`, () => {
  jest.setTimeout(30_000);

  const SLOT_MS = JOB_SLOT_S * 1000;
  const EVENTS = 5;
  // A random minute in 2001, so no run of this suite and no live slot shares a slot with another.
  const base =
    Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 400_000) * SLOT_MS;
  // Spaced past the fenced arm's catch-up window, so one test's backfill never reaches another's slot.
  const slotFor = (test: number) => base + test * 20 * SLOT_MS;
  const nowFor = (slot: number) => slot + SLOT_MS + JOB_GRACE_S * 1000 + 1;

  const owner = new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  let apps: INestApplication[] = [];
  let jobs: JobsService[] = [];
  let redis: RedisService;
  let org: string;

  /** Ledger rows inside the slot, which the rollup must sum exactly once. */
  async function seedLedger(slot: number): Promise<void> {
    await owner.query(
      `INSERT INTO usage_events (org_id, period, metric, quantity, occurred_at)
       SELECT $1, $2::timestamptz::date, 'events', 1, $2::timestamptz + interval '1 second'
         FROM generate_series(1, $3)`,
      [org, new Date(slot), EVENTS],
    );
  }

  async function rollups(slot: number) {
    const { rows } = await owner.query<{ rows: number; quantity: number }>(
      `SELECT count(*)::int AS rows, coalesce(sum(quantity), 0)::int AS quantity
         FROM usage_rollups WHERE org_id = $1 AND slot_start = $2`,
      [org, new Date(slot)],
    );
    return rows[0];
  }

  /** Every app steps down and the key is gone, so each test starts with no leader. */
  async function noLeader(): Promise<void> {
    await Promise.all(jobs.map((j) => j.beforeApplicationShutdown()));
    await redis.del(LEASE_KEY);
  }

  beforeAll(async () => {
    await owner.connect();
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
      [`replicas-e2e-${Date.now()}`],
    );
    org = rows[0].id;

    for (let i = 0; i < 3; i++) {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      apps.push(app);
    }
    jobs = apps.map((app) => app.get(JobsService));
    redis = apps[0].get(RedisService);
  });

  beforeEach(noLeader);

  afterAll(async () => {
    await noLeader();
    await Promise.all(apps.map((app) => app.close()));
    apps = [];
    await owner.query(
      `DELETE FROM job_runs WHERE job = $1 AND slot_start BETWEEN $2 AND $3`,
      [JOB, new Date(base - 20 * SLOT_MS), new Date(slotFor(5))],
    );
    for (const table of ['usage_rollups', 'usage_events']) {
      await owner.query(`DELETE FROM ${table} WHERE org_id = $1`, [org]);
    }
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [org]);
    await owner.end();
  });

  it('rolls a slot up once when three replicas tick it', async () => {
    const slot = slotFor(1);
    await seedLedger(slot);

    await Promise.all(jobs.map((j) => j.tick(nowFor(slot))));

    expect(await rollups(slot)).toEqual({ rows: 1, quantity: EVENTS });
  });

  it('does not re-run a finished slot after a failover', async () => {
    const slot = slotFor(2);
    await seedLedger(slot);
    const [a, b] = jobs;

    await a.lead();
    await a.tick(nowFor(slot));
    // A dies without releasing: its lease expires, and B takes over at the same moment.
    await redis.del(LEASE_KEY);
    await b.tick(nowFor(slot));

    expect(await rollups(slot)).toEqual({ rows: 1, quantity: EVENTS });
  });

  it('runs a slot once when its holder is paused past the lease mid-job', async () => {
    const slot = slotFor(3);
    await seedLedger(slot);
    const [a, b] = jobs;

    await a.lead();
    const paused = a.runSlot(slot, 1500);
    await sleep(300);
    // The lease runs out while A is still inside its transaction, and B becomes leader.
    await redis.del(LEASE_KEY);
    await b.tick(nowFor(slot));
    await paused;

    expect(await rollups(slot)).toEqual({ rows: 1, quantity: EVENTS });
  });

  it('rolls back a holder killed mid-job, and the next leader runs the slot once', async () => {
    const slot = slotFor(4);
    await seedLedger(slot);
    const [a, b] = jobs;

    await a.lead();
    const killed = a.runSlot(slot, 3000);
    await sleep(300);
    await owner.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`,
      [`job:${a.holder}`],
    );
    expect(await killed).toBe('failed');
    expect(await rollups(slot)).toEqual({ rows: 0, quantity: 0 });

    await redis.del(LEASE_KEY);
    await b.tick(nowFor(slot));

    expect(await rollups(slot)).toEqual({ rows: 1, quantity: EVENTS });
  });

  it('admits one limit across three replicas, not three', async () => {
    const LIMIT = 60;
    const FREE: Entitlements = {
      plan: 'free',
      ingestPerMinute: LIMIT,
      loadedAt: Date.now(),
    };
    const limiters = apps.map((app) => app.get(EntitlementsService));
    const key = `replicas-e2e-${Date.now()}`;

    const startedAt = Date.now();
    const decisions = await Promise.all(
      Array.from({ length: 3 * LIMIT }, (_, i) =>
        limiters[i % 3].consumeIngest(key, FREE),
      ),
    );
    const refilled = Math.ceil((Date.now() - startedAt) / 1000);
    await redis.del(rateLimitKey(key));

    const admitted = decisions.filter((d) => d?.allowed).length;
    expect(admitted).toBeLessThanOrEqual(LIMIT + refilled);
  });
});
