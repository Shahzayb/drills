// Card 13's instrument: what concurrency does to a counter, and what each fix
// costs to stop it.
//
//   pnpm db:quota fire    N concurrent deliveries at POST /ingest — asserts
//   pnpm db:quota bench   the four arms in raw SQL, same concurrency
//   pnpm db:quota race    two sessions, controlled interleaving, no luck
//   pnpm db:quota skew    the stretch: a second counter, one shared limit
//
// The two reproductions answer different questions and both belong. `race`
// CONTROLS the interleaving with two live sessions, so it cannot flake and it
// shows the mechanism. `fire` and `bench` are statistical: they show the bug
// happening under ordinary load, which is the thing that is hard to believe
// until you watch it.
//
// A deliberate sleep between the SELECT and the UPDATE was considered and
// rejected. It would make the red run reproduce every time and would prove that
// the code sleeps, not that it races.
//
// `fire` is a correctness proof, not a benchmark: it ASSERTS and exits 1.
//
//   usage_counters.used     == REQUESTS       the card's DONE WHEN
//   usage_counters.used     == count(ledger)  the counter agrees with the truth
//   5xx responses           == 0              nobody was told to go away
//   peak in flight          == CONCURRENCY    the run really was concurrent
//
// Method, inherited from drill 05 and not negotiable: arms INTERLEAVED in one
// sitting, medians not means, nothing under ~15% is a result. Between arms,
// `QUOTA=<arm> docker compose up -d nest_server` and then `pnpm arms`.
//
// `.mts` and not `.ts`: apps/backend/package.json has no `type` field, so a
// `.ts` here would be CommonJS and this file's top-level await would be a
// syntax error. See plans/2026-08-30_instrument-typescript.md.
//
// Full reasoning: plans/2026-09-07_drill-13-lost-update.md.

import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  client as pgClient,
  header,
  knob,
  knobNumber,
  median,
  record,
  serverArms,
} from './lib/run.mts';

const subcommand = process.argv[2];
const SUBCOMMANDS = ['fire', 'bench', 'race', 'skew'];
const USAGE = `usage: node db/quota.mts <${SUBCOMMANDS.join('|')}>`;

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

// `||` and not `??` throughout: the root script forwards these with
// `docker compose exec -e ORG_ID`, and an unset host variable arrives as the
// empty string, not as absent.
const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const ORG_ID = knob('ORG_ID', '1');
// The card's number. 100 concurrent increments, final count must equal 100.
const REQUESTS = knobNumber('REQUESTS', 100);
const CONCURRENCY = knobNumber('CONCURRENCY', 100);
// bench/skew repeat each arm this many times and report the median.
const ROUNDS = knobNumber('ROUNDS', 3);
// Substring filter over arm labels, for re-running one row of the table.
const ONLY = knob('ONLY', '');
// The shared cap `skew` races against. Deliberately small: the invariant is
// what is being tested, not the arithmetic.
const QUOTA_LIMIT = knobNumber('QUOTA_LIMIT', 100);

const METRIC = 'events';
// The same expression the service uses, and it has to stay the same expression
// — a counter keyed on one month and a ledger keyed on another agree about
// nothing. See PERIOD_SQL in src/ingest/ingest.service.ts.
const PERIOD = `date_trunc('month', now() AT TIME ZONE 'UTC')::date`;

const client = pgClient();

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/** Mint a key for an org and return the plaintext. Runs as the owner, which RLS
 *  exempts — the same reason db/seed.mts can write across tenants. */
async function mintKey(org: string, name: string): Promise<string> {
  const key = `dk_${randomUUID().replace(/-/g, '')}`;
  await client.query(
    `INSERT INTO api_keys (org_id, name, key_hash) VALUES ($1::bigint, $2, $3)`,
    [org, name, hash(key)],
  );
  return key;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    : 0;

// --------------------------------------------------------------- shared bits

/** The meter and its oracle, side by side. `used` is a cache of `ledger`; where
 *  they disagree, the difference is the lost updates. */
async function readMeter(org: string, metric = METRIC) {
  const { rows } = await client.query<{ used: string; ledger: string }>(
    `SELECT coalesce(c.used, 0)::text AS used,
            (SELECT count(*) FROM usage_events e
              WHERE e.org_id = $1::bigint AND e.period = ${PERIOD}
                AND e.metric = $2)::text AS ledger
       FROM (SELECT 1) one
       LEFT JOIN usage_counters c
         ON c.org_id = $1::bigint AND c.period = ${PERIOD} AND c.metric = $2`,
    [org, metric],
  );
  return { used: Number(rows[0].used), ledger: Number(rows[0].ledger) };
}

/** Zero the counter and the ledger for one (org, period, metric), so a run
 *  starts from a known number rather than from whatever the last one left. */
async function resetMeter(org: string, metric = METRIC): Promise<void> {
  await client.query(
    `DELETE FROM usage_events
      WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
    [org, metric],
  );
  await client.query(
    `INSERT INTO usage_counters (org_id, period, metric, used, quota_limit)
     VALUES ($1::bigint, ${PERIOD}, $2, 0, $3::bigint)
     ON CONFLICT (org_id, period, metric)
       DO UPDATE SET used = 0, quota_limit = $3::bigint`,
    [org, metric, QUOTA_LIMIT],
  );
}

interface Outcome {
  status: number;
  ms: number;
  retries: number;
}

/**
 * Fire `bodies` at the endpoint with a bounded number in flight.
 *
 * `inFlight` is tracked and reported, not assumed. Node's global undici
 * dispatcher pools connections per origin, and if it capped them below
 * CONCURRENCY this whole instrument would be a sequential loop wearing a
 * concurrent one's name — passing while testing nothing. A run whose peak is
 * below CONCURRENCY fails the assertions rather than being quietly believed.
 */
async function fireAll(
  ids: string[],
  key: string,
): Promise<{ outcomes: Outcome[]; peakInFlight: number }> {
  const outcomes: Outcome[] = new Array(ids.length);
  let next = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;

      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;

      const startedAt = performance.now();
      let status = 0;
      let retries = 0;
      try {
        const response = await fetch(`${API}/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            eventId: ids[index],
            message: `quota delivery of ${ids[index]}`,
          }),
        });
        status = response.status;
        // The HEADER, not the body. A 503 from an exhausted retry loop carries
        // Nest's error body, which has no `retries` field — reading the body
        // measured 0.50 retries per request where the header says several
        // times more, because it silently excluded the requests that retried
        // hardest. See TXN_RETRY_HEADER.
        retries = Number(response.headers.get('x-txn-retries') ?? 0);
        // Drained, not ignored: an unread body keeps the socket busy and the
        // next request opens another one, which quietly changes the
        // concurrency this instrument claims to be running at.
        await response.arrayBuffer();
      } catch {
        status = 0;
      }

      outcomes[index] = { status, ms: performance.now() - startedAt, retries };
      inFlight--;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
  );

  return { outcomes, peakInFlight };
}

async function cleanup(org: string, ids: string[]): Promise<number> {
  // usage_events first (FK to conversations), then messages, then conversations.
  await client.query(
    `DELETE FROM usage_events WHERE conversation_id IN (
       SELECT id FROM conversations
        WHERE org_id = $1::bigint AND provider_event_id = ANY($2::text[]))`,
    [org, ids],
  );
  await client.query(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT id FROM conversations
        WHERE org_id = $1::bigint AND provider_event_id = ANY($2::text[]))`,
    [org, ids],
  );
  const gone = await client.query(
    // = ANY over the ids held in memory, NOT `LIKE 'prefix%'`: under a non-C
    // collation a prefix LIKE cannot use the btree, so cleanup on the whale
    // would sequential-scan 2.5M rows every run.
    `DELETE FROM conversations
      WHERE org_id = $1::bigint AND provider_event_id = ANY($2::text[])`,
    [org, ids],
  );
  return gone.rowCount ?? 0;
}

// --------------------------------------------------------------------- fire

/**
 * The DONE WHEN, over HTTP: N concurrent increments, final count must be N.
 *
 * Every event id is DISTINCT, which is the opposite of drill 12's storm. There
 * the interesting request was the duplicate; here every delivery is billable, so
 * every delivery moves the meter and all of them contend on one row.
 */
async function fire() {
  const prefix = `quota-${Date.now().toString(36)}`;
  const ids = Array.from(
    { length: REQUESTS },
    (_, i) => `${prefix}-${String(i).padStart(6, '0')}`,
  );
  const key = await mintKey(ORG_ID, prefix);

  console.log(`  prefix ${prefix}  (cleanup key, if this run dies)\n`);

  await resetMeter(ORG_ID);

  const startedAt = performance.now();
  const { outcomes, peakInFlight } = await fireAll(ids, key);
  const wallMs = performance.now() - startedAt;

  const hist = new Map<number, number>();
  for (const o of outcomes) hist.set(o.status, (hist.get(o.status) ?? 0) + 1);
  const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const retries = outcomes.reduce((n, o) => n + o.retries, 0);
  const serverErrors = [...hist].reduce(
    (n, [status, count]) => (status >= 500 ? n + count : n),
    0,
  );

  const meter = await readMeter(ORG_ID);
  const lost = meter.ledger - meter.used;

  console.log(
    `  requests            ${REQUESTS.toLocaleString()} distinct events`,
  );
  console.log(
    `  concurrency         ${CONCURRENCY} requested, ${peakInFlight} peak in flight`,
  );
  console.log(
    `  wall clock          ${(wallMs / 1000).toFixed(2)}s  ${(ids.length / (wallMs / 1000)).toFixed(0)} req/s`,
  );
  console.log('');
  console.log(`  201 created         ${(hist.get(201) ?? 0).toLocaleString()}`);
  console.log(`  200 duplicate       ${(hist.get(200) ?? 0).toLocaleString()}`);
  console.log(`  503 give up         ${(hist.get(503) ?? 0).toLocaleString()}`);
  console.log(`  5xx                 ${serverErrors.toLocaleString()}`);
  console.log(`  transport failures  ${(hist.get(0) ?? 0).toLocaleString()}`);
  console.log('');
  console.log(
    `  counter used        ${meter.used.toLocaleString()} (expected ${REQUESTS.toLocaleString()})`,
  );
  console.log(`  ledger rows         ${meter.ledger.toLocaleString()}`);
  console.log(
    `  LOST UPDATES        ${lost.toLocaleString()}  (${((lost / Math.max(1, meter.ledger)) * 100).toFixed(1)}% of billable events never billed)`,
  );
  console.log(
    `  retries             ${retries.toLocaleString()}  (${(retries / REQUESTS).toFixed(2)} per request)`,
  );
  console.log('');
  console.log(
    `  p50 / p95 / p99     ${median(sorted).toFixed(2)} / ${percentile(sorted, 0.95).toFixed(2)} / ${percentile(sorted, 0.99).toFixed(2)} ms`,
  );

  const removed = await cleanup(ORG_ID, ids);
  await client.query(`DELETE FROM api_keys WHERE key_hash = $1`, [hash(key)]);
  console.log(
    `\n  cleaned up          ${removed.toLocaleString()} conversations`,
  );

  // Reported before they are enforced, so a red run still leaves every number
  // in the report directory.
  const failures: string[] = [];
  if (meter.used !== REQUESTS) {
    failures.push(
      `counter ${meter.used} != ${REQUESTS} — ${lost} lost updates`,
    );
  }
  if (meter.used !== meter.ledger) {
    failures.push(`counter ${meter.used} != ledger ${meter.ledger}`);
  }
  if (serverErrors) failures.push(`${serverErrors} 5xx responses`);
  if (peakInFlight < CONCURRENCY) {
    failures.push(
      `peak in flight ${peakInFlight} < CONCURRENCY ${CONCURRENCY} — the run was not concurrent`,
    );
  }

  return {
    result: {
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      peakInFlight,
      wallMs: Number(wallMs.toFixed(1)),
      created: hist.get(201) ?? 0,
      duplicate: hist.get(200) ?? 0,
      unavailable: hist.get(503) ?? 0,
      serverErrors,
      transportErrors: hist.get(0) ?? 0,
      counter: meter.used,
      ledger: meter.ledger,
      lost,
      retries,
      p50: Number(median(sorted).toFixed(2)),
      p95: Number(percentile(sorted, 0.95).toFixed(2)),
      p99: Number(percentile(sorted, 0.99).toFixed(2)),
    },
    failures,
  };
}

// -------------------------------------------------------------------- bench

const cfg = () => ({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

/**
 * The four increments, in raw SQL, as the service issues them.
 *
 * Deliberately a second copy of the shapes in src/ingest/ingest.service.ts, and
 * the duplication is the instrument's whole value: `fire` measures the ENDPOINT
 * — auth, the conversation upsert, the message, the ledger, RLS, the pool — and
 * this measures the MECHANISM with all of that removed. Two numbers that
 * disagree are informative; one number that cannot say which layer it came from
 * is not. Same split as db/paging.mts against db/explain.mts.
 */
type Arm = 'rmw' | 'atomic' | 'locking' | 'serializable';
const ARMS: Arm[] = ['rmw', 'atomic', 'locking', 'serializable'];

/** One increment on one connection, returning how many times it restarted. */
async function increment(c: pg.PoolClient, org: string, arm: Arm) {
  const begin =
    arm === 'serializable' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN';
  const lock = arm === 'locking' ? ' FOR UPDATE' : '';

  for (let attempt = 0; ; attempt++) {
    await c.query(begin);
    try {
      if (arm === 'atomic') {
        await c.query(
          `INSERT INTO usage_counters (org_id, period, metric, used)
           VALUES ($1::bigint, ${PERIOD}, $2, 1)
           ON CONFLICT (org_id, period, metric)
             DO UPDATE SET used = usage_counters.used + 1, updated_at = now()`,
          [org, METRIC],
        );
      } else {
        const { rows } = await c.query<{ used: string }>(
          `SELECT used FROM usage_counters
            WHERE org_id = $1::bigint AND period = ${PERIOD}
              AND metric = $2${lock}`,
          [org, METRIC],
        );
        await c.query(
          `UPDATE usage_counters SET used = $3::bigint, updated_at = now()
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
          [org, METRIC, Number(rows[0].used) + 1],
        );
      }
      await c.query('COMMIT');
      return attempt;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string }).code;
      // Same policy as TenantDb.withOrg: 40001 and 40P01 are "run it again",
      // anything else is a real error. The cap is generous here because the
      // question is what the retry rate IS, not what a production cap does to it.
      if ((code !== '40001' && code !== '40P01') || attempt >= 50) throw error;
      await new Promise((r) =>
        setTimeout(r, Math.random() * Math.min(16, 1 << attempt)),
      );
    }
  }
}

/** One arm, once: REQUESTS increments at CONCURRENCY, straight against Postgres. */
async function benchOnce(arm: Arm) {
  await resetMeter(ORG_ID);

  // max = CONCURRENCY, not the app's 10: this measures the mechanism, and a
  // pool smaller than the concurrency would measure the pool. `fire` is the arm
  // that runs through the real pool, on purpose.
  const pool = new pg.Pool({ ...cfg(), max: CONCURRENCY });
  const durations: number[] = [];
  let retries = 0;
  let errors = 0;
  let next = 0;

  const startedAt = performance.now();
  try {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        const c = await pool.connect();
        try {
          for (;;) {
            if (next++ >= REQUESTS) return;
            const began = performance.now();
            try {
              retries += await increment(c, ORG_ID, arm);
            } catch {
              errors++;
            }
            durations.push(performance.now() - began);
          }
        } finally {
          c.release();
        }
      }),
    );
  } finally {
    await pool.end();
  }
  const wallMs = performance.now() - startedAt;

  const meter = await readMeter(ORG_ID);
  const sorted = durations.sort((a, b) => a - b);

  return {
    arm,
    counter: meter.used,
    lost: REQUESTS - meter.used,
    retries,
    errors,
    rps: REQUESTS / (wallMs / 1000),
    p50: median(sorted),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/**
 * Refuse a run that cannot be as concurrent as it claims.
 *
 * One transaction needs one connection, so CONCURRENCY connections have to fit
 * inside max_connections with the app's pool and everything else already in
 * there. Without this the pool raises 53300 `sorry, too many clients already`
 * from inside pg's connect path, a hundred lines of stack that never names the
 * setting — and the alternative failure is worse: a pool that quietly
 * serialises would report a lost-update-free `rmw` arm.
 */
async function assertConnectionHeadroom(): Promise<void> {
  const { rows } = await client.query<{
    max: string;
    reserved: string;
    inUse: string;
  }>(
    `SELECT current_setting('max_connections') AS max,
            current_setting('superuser_reserved_connections') AS reserved,
            (SELECT count(*)::text FROM pg_stat_activity) AS "inUse"`,
  );
  const free =
    Number(rows[0].max) - Number(rows[0].reserved) - Number(rows[0].inUse);

  if (free < CONCURRENCY) {
    console.error(
      `\n  CONCURRENCY ${CONCURRENCY} needs ${CONCURRENCY} connections and only ` +
        `${free} are free\n  (max_connections=${rows[0].max}, reserved=${rows[0].reserved}, ` +
        `in use=${rows[0].inUse}).\n\n` +
        `    PG_MAX_CONNECTIONS=200 docker compose up -d postgres_db\n\n` +
        `  or lower --concurrency. A run that cannot open the connections is not ` +
        `a quieter\n  measurement, it is a different one.\n`,
    );
    process.exit(1);
  }
}

async function bench() {
  await assertConnectionHeadroom();

  const arms = ARMS.filter((a) => !ONLY || a.includes(ONLY));
  const rows: Record<string, unknown>[] = [];

  console.log(
    `  ${REQUESTS} increments at concurrency ${CONCURRENCY}, ${ROUNDS} rounds, median\n`,
  );
  console.log(
    '  arm            counter   lost   retries/req   err    req/s      p50      p95      p99',
  );

  // Round-robin, not arm-blocked: round 1 runs every arm, then round 2 does.
  // Drill 05's rule is that arms are interleaved because this laptop drifts,
  // and a loop that finishes one arm before starting the next is the shape that
  // rule exists to forbid — even over the thirty seconds this takes.
  const results = new Map<Arm, Awaited<ReturnType<typeof benchOnce>>[]>(
    arms.map((a) => [a, []]),
  );
  for (let round = 0; round < ROUNDS; round++) {
    for (const arm of arms) results.get(arm)!.push(await benchOnce(arm));
  }

  for (const arm of arms) {
    const runs = results.get(arm)!;

    const pick = <K extends keyof (typeof runs)[number]>(k: K) =>
      median(runs.map((r) => Number(r[k])));

    const row = {
      arm,
      counter: pick('counter'),
      lost: pick('lost'),
      retriesPerRequest: pick('retries') / REQUESTS,
      errors: pick('errors'),
      rps: pick('rps'),
      p50: pick('p50'),
      p95: pick('p95'),
      p99: pick('p99'),
    };
    rows.push(row);

    console.log(
      `  ${arm.padEnd(14)} ${String(row.counter).padStart(7)} ${String(row.lost).padStart(6)} ` +
        `${row.retriesPerRequest.toFixed(2).padStart(13)} ${String(row.errors).padStart(5)} ` +
        `${row.rps.toFixed(0).padStart(8)} ${row.p50.toFixed(2).padStart(8)} ` +
        `${row.p95.toFixed(2).padStart(8)} ${row.p99.toFixed(2).padStart(8)}`,
    );
  }

  console.log(
    `\n  counter must equal ${REQUESTS}. Anything less is money the meter did not bill.`,
  );

  await resetMeter(ORG_ID);
  return rows;
}

// --------------------------------------------------------------------- race

/**
 * The deterministic reproduction: two sessions, an interleaving this file
 * chooses, and no luck involved.
 *
 * Experiment 1 is the bug itself, printed step by step. Experiment 2 runs the
 * SAME interleaving at three isolation levels, which is the card's actual
 * question — what does READ COMMITTED guarantee, and what does it not.
 */
async function race() {
  const org = (
    await client.query<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
      [`quota-race-${Date.now()}`],
    )
  ).rows[0].id;

  const rows: Record<string, unknown>[] = [];

  const seed = () =>
    client.query(
      `INSERT INTO usage_counters (org_id, period, metric, used, quota_limit)
       VALUES ($1::bigint, ${PERIOD}, $2, 99, $3::bigint)
       ON CONFLICT (org_id, period, metric) DO UPDATE SET used = 99`,
      [org, METRIC, QUOTA_LIMIT],
    );

  const used = async () =>
    Number(
      (
        await client.query<{ used: string }>(
          `SELECT used::text AS used FROM usage_counters
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
          [org, METRIC],
        )
      ).rows[0].used,
    );

  try {
    // --- 1. the lost update, step by step ---------------------------------
    await seed();

    const A = new pg.Client(cfg());
    const B = new pg.Client(cfg());
    await A.connect();
    await B.connect();

    const read = async (c: pg.Client) =>
      Number(
        (
          await c.query<{ used: string }>(
            `SELECT used::text AS used FROM usage_counters
              WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
            [org, METRIC],
          )
        ).rows[0].used,
      );

    const write = (c: pg.Client, value: number) =>
      c.query(
        `UPDATE usage_counters SET used = $3::bigint
          WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
        [org, METRIC, value],
      );

    console.log('  1. read-modify-write, two sessions, counter starts at 99\n');

    await A.query('BEGIN');
    await B.query('BEGIN');
    const aRead = await read(A);
    console.log(`     A  SELECT used            -> ${aRead}`);
    const bRead = await read(B);
    console.log(`     B  SELECT used            -> ${bRead}`);
    await write(A, aRead + 1);
    console.log(`     A  UPDATE used = ${aRead + 1}`);
    await A.query('COMMIT');
    console.log('     A  COMMIT');
    await write(B, bRead + 1);
    console.log(`     B  UPDATE used = ${bRead + 1}`);
    await B.query('COMMIT');
    console.log('     B  COMMIT');

    const after = await used();
    console.log(
      `\n     counter = ${after}. Two deliveries, one billed. No error, no ` +
        `conflict, no log line.`,
    );
    console.log(
      '     Both statements succeeded and the database is doing exactly what it promised.\n',
    );
    rows.push({ experiment: 'lost-update', start: 99, after, expected: 101 });

    await A.end();
    await B.end();

    // --- 2. the same interleaving, three isolation levels -----------------
    console.log(
      '  2. the same interleaving at each isolation level, and with the fixes\n',
    );
    console.log(
      '     shape                 isolation         B write          counter  ok',
    );

    const SHAPES: { label: string; lock: boolean; atomic?: boolean }[] = [
      { label: 'read-modify-write', lock: false },
      { label: 'SELECT FOR UPDATE', lock: true },
      { label: 'used = used + 1', lock: false, atomic: true },
    ];

    for (const level of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
      for (const shape of SHAPES) {
        await seed();
        const S1 = new pg.Client(cfg());
        const S2 = new pg.Client(cfg());
        await S1.connect();
        await S2.connect();

        const bump = async (c: pg.Client) => {
          if (shape.atomic) {
            await c.query(
              `UPDATE usage_counters SET used = used + 1
                WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
              [org, METRIC],
            );
            return;
          }
          const { rows: r } = await c.query<{ used: string }>(
            `SELECT used FROM usage_counters
              WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2` +
              (shape.lock ? ' FOR UPDATE' : ''),
            [org, METRIC],
          );
          await write(c, Number(r[0].used) + 1);
        };

        await S1.query(`BEGIN ISOLATION LEVEL ${level}`);
        await S2.query(`BEGIN ISOLATION LEVEL ${level}`);
        // Both snapshots are taken before either writes. That is what makes
        // this a race rather than a sequence, and it is why the FOR UPDATE row
        // has to start its read after S1 has already taken the lock.
        await S1.query('SELECT 1');
        await S2.query('SELECT 1');

        await bump(S1);
        // S2 runs concurrently: on the locking and atomic shapes it BLOCKS
        // here until S1 commits, which is the entire mechanism.
        const second = bump(S2).then(
          () => 'ok',
          (e: { code?: string }) => `ERROR ${e.code ?? '?'}`,
        );
        await new Promise((r) => setTimeout(r, 100));
        await S1.query('COMMIT');

        const outcome = await second;
        await S2.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(
          () => undefined,
        );

        const counter = await used();
        // 101 is right whether B committed or was told to retry — a rejected
        // transaction that the caller retries lands on 101 too. 100 is the
        // silent loss, and it is the only wrong answer here.
        const ok = counter === 101 || outcome !== 'ok';

        console.log(
          `     ${shape.label.padEnd(21)} ${level.padEnd(17)} ${outcome.padEnd(16)} ${String(counter).padStart(7)}  ${ok ? 'yes' : 'NO'}`,
        );
        rows.push({
          experiment: 'isolation',
          shape: shape.label,
          isolation: level,
          second: outcome,
          counter,
          ok,
        });

        await S1.end();
        await S2.end();
      }
    }

    console.log('');
    console.log(
      '     READ COMMITTED does not stop the lost update, and it is not broken:',
    );
    console.log(
      '     it promises you never read uncommitted data. It says nothing about a',
    );
    console.log('     value going stale between your SELECT and your UPDATE.');
  } finally {
    await client.query(`DELETE FROM usage_counters WHERE org_id = $1::bigint`, [
      org,
    ]);
    await client.query(`DELETE FROM organizations WHERE id = $1::bigint`, [
      org,
    ]);
  }

  return rows;
}

// --------------------------------------------------------------------- skew

/**
 * The stretch: a second counter that must stay consistent with the first.
 *
 * The invariant is `events.used + messages.used <= quota_limit` — one budget,
 * two metric ROWS. That is the whole difficulty: a fix that protects the row it
 * writes does nothing about the row it only read.
 *
 *   A: if sum(used) < limit, events.used   += 1
 *   B: if sum(used) < limit, messages.used += 1
 *
 * Both read 99 against a limit of 100, both pass, both write. 101, and neither
 * transaction ever touched the same row as the other. This is write skew, and
 * it is a different bug from the lost update wearing similar clothes.
 */
async function skew() {
  const org = (
    await client.query<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
      [`quota-skew-${Date.now()}`],
    )
  ).rows[0].id;

  const rows: Record<string, unknown>[] = [];

  // Start one under the cap, so exactly one of the two concurrent increments
  // may legally happen. Anything more is a breach.
  const start = QUOTA_LIMIT - 1;

  const seed = async () => {
    for (const [metric, used] of [
      ['events', start],
      ['messages', 0],
    ] as const) {
      await client.query(
        `INSERT INTO usage_counters (org_id, period, metric, used, quota_limit)
         VALUES ($1::bigint, ${PERIOD}, $2, $3::bigint, $4::bigint)
         ON CONFLICT (org_id, period, metric)
           DO UPDATE SET used = $3::bigint, quota_limit = $4::bigint`,
        [org, metric, used, QUOTA_LIMIT],
      );
    }
  };

  const total = async () =>
    Number(
      (
        await client.query<{ n: string }>(
          `SELECT coalesce(sum(used), 0)::text AS n FROM usage_counters
            WHERE org_id = $1::bigint AND period = ${PERIOD}`,
          [org],
        )
      ).rows[0].n,
    );

  type Fix = {
    label: string;
    isolation: string;
    run: (c: pg.Client, metric: string) => Promise<void>;
  };

  const FIXES: Fix[] = [
    {
      // The atomic fix cannot express this. It is one statement and one row;
      // the guard has to read the OTHER row, and a subquery reads it from this
      // statement's snapshot, where the concurrent increment does not exist.
      label: 'atomic UPDATE',
      isolation: 'READ COMMITTED',
      run: async (c, metric) => {
        await c.query(
          `UPDATE usage_counters SET used = used + 1
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2
              AND (SELECT sum(used) FROM usage_counters
                    WHERE org_id = $1::bigint AND period = ${PERIOD})
                  < quota_limit`,
          [org, metric],
        );
      },
    },
    {
      // Locking only the row you WRITE. The obvious reading of "use FOR UPDATE",
      // and it holds nothing here: the two transactions lock different rows.
      label: 'FOR UPDATE (write row)',
      isolation: 'READ COMMITTED',
      run: async (c, metric) => {
        const { rows: r } = await c.query<{ used: string; sum: string }>(
          `SELECT used::text AS used,
                  (SELECT sum(used) FROM usage_counters
                    WHERE org_id = $1::bigint AND period = ${PERIOD})::text AS sum
             FROM usage_counters
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2
              FOR UPDATE`,
          [org, metric],
        );
        if (Number(r[0].sum) >= QUOTA_LIMIT) return;
        await c.query(
          `UPDATE usage_counters SET used = $3::bigint
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
          [org, metric, Number(r[0].used) + 1],
        );
      },
    },
    {
      // Locking every row you READ. Correct, and the ORDER BY is not optional:
      // two transactions taking the same locks in different orders deadlock.
      label: 'FOR UPDATE (all read)',
      isolation: 'READ COMMITTED',
      run: async (c, metric) => {
        const { rows: r } = await c.query<{ metric: string; used: string }>(
          `SELECT metric, used::text AS used FROM usage_counters
            WHERE org_id = $1::bigint AND period = ${PERIOD}
            ORDER BY metric FOR UPDATE`,
          [org],
        );
        const sum = r.reduce((n, x) => n + Number(x.used), 0);
        if (sum >= QUOTA_LIMIT) return;
        const mine = r.find((x) => x.metric === metric);
        await c.query(
          `UPDATE usage_counters SET used = $3::bigint
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
          [org, metric, Number(mine!.used) + 1],
        );
      },
    },
    {
      // The same read-then-write as the broken row-lock version, unchanged.
      // Only the isolation level differs, and SSI sees the rw-dependency.
      label: 'SERIALIZABLE',
      isolation: 'SERIALIZABLE',
      run: async (c, metric) => {
        const { rows: r } = await c.query<{ used: string; sum: string }>(
          `SELECT used::text AS used,
                  (SELECT sum(used) FROM usage_counters
                    WHERE org_id = $1::bigint AND period = ${PERIOD})::text AS sum
             FROM usage_counters
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
          [org, metric],
        );
        if (Number(r[0].sum) >= QUOTA_LIMIT) return;
        await c.query(
          `UPDATE usage_counters SET used = $3::bigint
            WHERE org_id = $1::bigint AND period = ${PERIOD} AND metric = $2`,
          [org, metric, Number(r[0].used) + 1],
        );
      },
    },
  ];

  try {
    console.log(
      `  two counters, one budget of ${QUOTA_LIMIT}. events starts at ${start}, messages at 0,\n` +
        `  so exactly ONE of the two concurrent increments may legally happen.\n`,
    );
    console.log(
      '  fix                       isolation         A         B                total  holds',
    );

    for (const fix of FIXES.filter((f) => !ONLY || f.label.includes(ONLY))) {
      await seed();

      const A = new pg.Client(cfg());
      const B = new pg.Client(cfg());
      await A.connect();
      await B.connect();

      const attempt = async (c: pg.Client, metric: string) => {
        await c.query(`BEGIN ISOLATION LEVEL ${fix.isolation}`);
        try {
          await fix.run(c, metric);
          await c.query('COMMIT');
          return 'ok';
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          return `ERROR ${(e as { code?: string }).code ?? '?'}`;
        }
      };

      // Started together, so both take their snapshots before either commits.
      const [a, b] = await Promise.all([
        attempt(A, 'events'),
        attempt(B, 'messages'),
      ]);

      const sum = await total();
      const holds = sum <= QUOTA_LIMIT;

      console.log(
        `  ${fix.label.padEnd(25)} ${fix.isolation.padEnd(17)} ${a.padEnd(9)} ${b.padEnd(16)} ${String(sum).padStart(5)}  ${holds ? 'yes' : 'NO'}`,
      );
      rows.push({
        fix: fix.label,
        isolation: fix.isolation,
        a,
        b,
        total: sum,
        limit: QUOTA_LIMIT,
        holds,
      });

      await A.end();
      await B.end();
    }

    console.log(
      `\n  The invariant is sum(used) <= ${QUOTA_LIMIT}. A row past it is an org served past its plan.`,
    );
  } finally {
    await client.query(`DELETE FROM usage_counters WHERE org_id = $1::bigint`, [
      org,
    ]);
    await client.query(`DELETE FROM organizations WHERE id = $1::bigint`, [
      org,
    ]);
  }

  return rows;
}

// --------------------------------------------------------------------- main

const armState = await serverArms(API);

header(`quota ${subcommand}  api ${API}`);
if (armState) console.log(`  server arms  ${JSON.stringify(armState)}\n`);

await client.connect();

let rows: unknown = null;
let failures: string[] = [];

try {
  if (subcommand === 'fire') {
    const out = await fire();
    rows = out.result;
    failures = out.failures;
  } else if (subcommand === 'bench') {
    rows = await bench();
  } else if (subcommand === 'race') {
    rows = await race();
  } else {
    rows = await skew();
  }
} finally {
  await client.end();
}

record('quota', subcommand, { rows, arms: armState });

if (failures.length) {
  console.error(`\n  FAILED\n${failures.map((f) => `    ${f}`).join('\n')}\n`);
  process.exit(1);
}
