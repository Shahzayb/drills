// Card 12's instrument: what a duplicate storm does to the ingest endpoint.
//
//   pnpm db:storm key            mint an api key for an org and print it once
//   pnpm db:storm fire           the storm — N requests, U unique, concurrent
//   pnpm db:storm race           what each mechanism is actually protecting
//   pnpm db:storm redis-restart  the guard forgotten mid-storm
//
// `fire` is the correctness proof, not a benchmark: it ASSERTS and exits 1.
// Three assertions, because the row count alone cannot tell a working endpoint
// from a broken one that the unique index happened to rescue —
//
//   conversations created == UNIQUE     the card's DONE WHEN
//   201 responses         == UNIQUE     exactly one delivery won each event
//   5xx responses         == 0          and nobody was told to go away
//
// IDEMPOTENCY=none passes the first and fails the other two, which is the whole
// reason there are three.
//
// Method, inherited from drill 05 and not negotiable: arms INTERLEAVED in one
// sitting, medians not means, nothing under ~15% is a result. Between arms,
// `IDEMPOTENCY=<arm> docker compose up -d nest_server` and then `pnpm arms` —
// a container older than the switch is drill 10's lost evening.
//
// `.mts` and not `.ts`: apps/backend/package.json has no `type` field, so a
// `.ts` here would be CommonJS and this file's top-level await would be a
// syntax error. See plans/2026-08-30_instrument-typescript.md.
//
// Full reasoning: plans/2026-08-31_drill-12-idempotent-ingest.md.

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
const SUBCOMMANDS = ['key', 'fire', 'race', 'redis-restart'];
const USAGE = `usage: node db/storm.mts <${SUBCOMMANDS.join('|')}>`;

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

// `||` and not `??` throughout: the root script forwards these with
// `docker compose exec -e ORG_ID`, and an unset host variable arrives as the
// empty string, not as absent.
const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const ORG_ID = knob('ORG_ID', '1');
// The card's numbers. 10,000 deliveries of 3,000 distinct events.
const REQUESTS = knobNumber('REQUESTS', 10_000);
const UNIQUE = knobNumber('UNIQUE', 3_000);
// How many are in flight at once. The pool is 10 and each request holds one
// connection for its transaction, so past ~50 this measures the pool rather
// than the mechanism — which is a real thing to see, just not the default.
const CONCURRENCY = knobNumber('CONCURRENCY', 50);
// adjacent | shuffled. See the comment on plan() — this is the knob that
// decides whether the experiment happens at all.
const SHAPE = knob('SHAPE', 'adjacent');
// Percent of the way through `redis-restart` at which the guard is wiped.
const FLUSH_AT = knobNumber('FLUSH_AT', 50);

if (UNIQUE > REQUESTS) {
  console.error(`UNIQUE (${UNIQUE}) cannot exceed REQUESTS (${REQUESTS})`);
  process.exit(1);
}

const client = pgClient();

// ------------------------------------------------------------------- api keys

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Mint a key for an org and return the plaintext.
 *
 * Runs as the owner, which RLS exempts — the same reason db/seed.mts can write
 * across tenants. The plaintext is returned here and stored nowhere: the table
 * holds a sha256 and `app_user` has no SELECT on it anyway.
 */
async function mintKey(org: string, name: string): Promise<string> {
  const key = `dk_${randomUUID().replace(/-/g, '')}`;
  await client.query(
    `INSERT INTO api_keys (org_id, name, key_hash) VALUES ($1::bigint, $2, $3)`,
    [org, name, hash(key)],
  );
  return key;
}

// ------------------------------------------------------------------ the storm

/**
 * The delivery order, and the single most important line in this file.
 *
 * `adjacent` puts an event's copies next to each other, so they land inside one
 * concurrency window and actually race. `shuffled` spreads them across the whole
 * run, which is what a naive generator produces — and then the winner has
 * committed long before the next copy arrives, nothing ever collides, and the
 * storm passes on EVERY arm including `none`. A shuffled storm is not a weaker
 * test of idempotency; it is not a test of idempotency.
 *
 * Both shapes are kept because the contrast is the point.
 */
function plan(prefix: string): string[] {
  const ids = Array.from(
    { length: UNIQUE },
    (_, i) => `${prefix}-${String(i).padStart(6, '0')}`,
  );

  const copies = Array.from({ length: REQUESTS }, (_, i) => ids[i % UNIQUE]);

  if (SHAPE === 'adjacent') {
    // i % UNIQUE already cycles; sorting groups each event's copies together.
    return copies.sort();
  }

  // Deterministic shuffle, so a re-run of the control arm is the same control.
  let seed = 12345;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  for (let i = copies.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [copies[i], copies[j]] = [copies[j], copies[i]];
  }
  return copies;
}

interface Outcome {
  status: number;
  ms: number;
}

/**
 * Fire `ids` at the endpoint with a bounded number in flight, and record what
 * came back.
 *
 * `inFlight` is tracked and reported, not assumed. Node's global undici
 * dispatcher pools connections per origin, and if it capped them below
 * CONCURRENCY this whole instrument would be a sequential loop wearing a
 * concurrent one's name — passing while testing nothing, which is the class of
 * bug `QUERY_COUNTER=off` was. A run whose peak is far below CONCURRENCY is
 * void, and the summary prints it so that is visible rather than believed.
 */
async function fireAll(
  ids: string[],
  key: string,
  onProgress?: (done: number) => Promise<void>,
): Promise<{ outcomes: Outcome[]; peakInFlight: number }> {
  const outcomes: Outcome[] = new Array(ids.length);
  let next = 0;
  let done = 0;
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
      try {
        const response = await fetch(`${API}/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            eventId: ids[index],
            message: `storm delivery of ${ids[index]}`,
          }),
        });
        status = response.status;
        // Drained, not ignored: an unread body keeps the socket busy and the
        // next request opens another one, which quietly changes the concurrency
        // this instrument claims to be running at.
        await response.arrayBuffer();
      } catch {
        // A transport failure is not a status. 0 keeps it out of the 5xx count
        // and the summary prints it separately.
        status = 0;
      }

      outcomes[index] = { status, ms: performance.now() - startedAt };
      inFlight--;
      done++;

      if (onProgress) await onProgress(done);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
  );

  return { outcomes, peakInFlight };
}

/** Live conversation and message counts for one run's event ids. */
async function countRows(org: string, ids: string[]) {
  const conversations = await client.query<{ id: string }>(
    // = ANY over the ids held in memory, NOT `LIKE 'prefix%'`: under a non-C
    // collation a prefix LIKE cannot use the btree, so cleanup on the whale
    // would sequential-scan 2.5M rows every run.
    `SELECT id FROM conversations
      WHERE org_id = $1::bigint AND provider_event_id = ANY($2::text[])`,
    [org, ids],
  );
  const messages = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE conversation_id = ANY($1::uuid[])`,
    [conversations.rows.map((r) => r.id)],
  );
  return {
    conversations: conversations.rows.length,
    messages: Number(messages.rows[0].n),
  };
}

/**
 * The write cost `ON_CONFLICT=update` pays that `nothing` does not.
 *
 * Three numbers, not one, because the obvious one is misleading on its own.
 * `n_dead_tup` came back an order of magnitude below the "one dead tuple per
 * duplicate" prediction, and `n_tup_hot_upd` is what says why: a no-op
 * assignment does not change any indexed value, so the update is eligible for
 * HOT, and a HOT tuple is pruned on the next access to its page instead of
 * waiting for vacuum.
 *
 * Approximate by nature — the stats collector is asynchronous, so these are read
 * after a settle rather than immediately.
 */
async function writeStats(): Promise<{
  dead: number;
  updates: number;
  hotUpdates: number;
}> {
  const { rows } = await client.query<{
    dead: string;
    upd: string;
    hot: string;
  }>(
    `SELECT n_dead_tup::text AS dead, n_tup_upd::text AS upd,
            n_tup_hot_upd::text AS hot
       FROM pg_stat_user_tables WHERE relname = 'conversations'`,
  );
  return {
    dead: Number(rows[0]?.dead ?? 0),
    updates: Number(rows[0]?.upd ?? 0),
    hotUpdates: Number(rows[0]?.hot ?? 0),
  };
}

const percentile = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    : 0;

function summarise(outcomes: Outcome[]) {
  const hist = new Map<number, number>();
  for (const o of outcomes) hist.set(o.status, (hist.get(o.status) ?? 0) + 1);
  const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  return {
    hist,
    created: hist.get(201) ?? 0,
    duplicate: hist.get(200) ?? 0,
    pending: hist.get(202) ?? 0,
    serverErrors: [...hist].reduce(
      (n, [status, count]) => (status >= 500 ? n + count : n),
      0,
    ),
    transportErrors: hist.get(0) ?? 0,
    p50: median(sorted),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

async function cleanup(org: string, ids: string[]): Promise<number> {
  // Messages first: the FK from messages.conversation_id would refuse.
  await client.query(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT id FROM conversations
        WHERE org_id = $1::bigint AND provider_event_id = ANY($2::text[]))`,
    [org, ids],
  );
  const gone = await client.query(
    `DELETE FROM conversations
      WHERE org_id = $1::bigint AND provider_event_id = ANY($2::text[])`,
    [org, ids],
  );
  return gone.rowCount ?? 0;
}

// --------------------------------------------------------------------- fire

async function fire(flushGuardAt: number | null = null) {
  const prefix = `storm-${Date.now().toString(36)}`;
  const ids = plan(prefix);
  const key = await mintKey(ORG_ID, prefix);

  console.log(`  prefix ${prefix}  (cleanup key, if this run dies)\n`);

  const before = await writeStats();

  // Typed off the constructor rather than off `import('ioredis').default`: with
  // `verbatimModuleSyntax` and nodenext resolution, ioredis's CJS default export
  // types as the module namespace, which has no construct signature.
  let redis: InstanceType<typeof import('ioredis').Redis> | null = null;
  let flushed = false;
  if (flushGuardAt !== null) {
    // Imported here and not at the top, because only this subcommand needs a
    // Redis connection at all and the others should not open one.
    const { Redis } = await import('ioredis');
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
    });
  }

  const startedAt = performance.now();
  const { outcomes, peakInFlight } = await fireAll(
    ids,
    key,
    redis
      ? async (done) => {
          if (flushed || done < (ids.length * flushGuardAt!) / 100) return;
          flushed = true;
          // FLUSHDB simulates the EFFECT of a restart — the guard state is gone
          // — and not the connection error. A real restart also breaks every
          // in-flight command, which is a separate run:
          // `docker compose restart redis_cache` mid-storm, by hand.
          await redis!.flushdb();
          process.stderr.write(`  --- FLUSHDB at ${done}/${ids.length}\n`);
        }
      : undefined,
  );
  const wallMs = performance.now() - startedAt;

  await redis?.quit();

  // The stats collector is asynchronous; reading n_dead_tup immediately after
  // the last COMMIT reports a number the storm has not finished producing.
  await new Promise((r) => setTimeout(r, 1500));
  const after = await writeStats();

  const s = summarise(outcomes);
  const rows = await countRows(ORG_ID, [...new Set(ids)]);

  console.log(
    `  requests            ${REQUESTS.toLocaleString()} (${UNIQUE.toLocaleString()} unique, shape ${SHAPE})`,
  );
  console.log(
    `  concurrency         ${CONCURRENCY} requested, ${peakInFlight} peak in flight`,
  );
  console.log(
    `  wall clock          ${(wallMs / 1000).toFixed(2)}s  ${(ids.length / (wallMs / 1000)).toFixed(0)} req/s`,
  );
  console.log('');
  console.log(`  201 created         ${s.created.toLocaleString()}`);
  console.log(`  200 duplicate       ${s.duplicate.toLocaleString()}`);
  console.log(`  202 pending         ${s.pending.toLocaleString()}`);
  console.log(`  5xx                 ${s.serverErrors.toLocaleString()}`);
  console.log(`  transport failures  ${s.transportErrors.toLocaleString()}`);
  console.log('');
  console.log(
    `  conversations       ${rows.conversations.toLocaleString()} (expected ${UNIQUE.toLocaleString()})`,
  );
  console.log(
    `  messages            ${rows.messages.toLocaleString()} (expected ${UNIQUE.toLocaleString()})`,
  );
  const updates = after.updates - before.updates;
  const hot = after.hotUpdates - before.hotUpdates;
  console.log(
    `  updates             ${updates.toLocaleString()} of which ${hot.toLocaleString()} HOT`,
  );
  console.log(
    `  dead tuples         +${(after.dead - before.dead).toLocaleString()}  (${before.dead.toLocaleString()} -> ${after.dead.toLocaleString()})`,
  );
  console.log('');
  console.log(
    `  p50 / p95 / p99     ${s.p50.toFixed(2)} / ${s.p95.toFixed(2)} / ${s.p99.toFixed(2)} ms`,
  );

  const removed = await cleanup(ORG_ID, [...new Set(ids)]);
  await client.query(`DELETE FROM api_keys WHERE key_hash = $1`, [hash(key)]);
  console.log(
    `\n  cleaned up          ${removed.toLocaleString()} conversations`,
  );

  // The assertions. Reported before they are enforced, so a red run still
  // leaves every number in the report directory.
  const failures: string[] = [];
  if (rows.conversations !== UNIQUE) {
    failures.push(`conversations ${rows.conversations} != ${UNIQUE}`);
  }
  if (s.created !== UNIQUE) failures.push(`201s ${s.created} != ${UNIQUE}`);
  if (s.serverErrors) failures.push(`${s.serverErrors} 5xx responses`);
  if (peakInFlight < CONCURRENCY) {
    failures.push(
      `peak in flight ${peakInFlight} < CONCURRENCY ${CONCURRENCY} — the run was not concurrent`,
    );
  }

  return {
    result: {
      requests: REQUESTS,
      unique: UNIQUE,
      shape: SHAPE,
      peakInFlight,
      wallMs: Number(wallMs.toFixed(1)),
      created: s.created,
      duplicate: s.duplicate,
      pending: s.pending,
      serverErrors: s.serverErrors,
      transportErrors: s.transportErrors,
      conversations: rows.conversations,
      messages: rows.messages,
      deadTuples: after.dead - before.dead,
      updates,
      hotUpdates: hot,
      p50: Number(s.p50.toFixed(2)),
      p95: Number(s.p95.toFixed(2)),
      p99: Number(s.p99.toFixed(2)),
      flushedGuardAt: flushGuardAt,
    },
    failures,
  };
}

// --------------------------------------------------------------------- race

/**
 * What each mechanism is protecting against, shown with two real sessions
 * rather than argued.
 *
 * Three experiments, and the second and third are the ones that corrected this
 * drill's own plan:
 *
 *   1. check-then-insert with NO constraint — the duplicate rows. This is the
 *      bug in its natural habitat, on a scratch table, because the shipped
 *      schema has the unique index and cannot show it.
 *   2. ON CONFLICT under READ COMMITTED — both shapes block on the concurrent
 *      inserter, and the DO NOTHING follow-up SELECT then FINDS the row,
 *      because READ COMMITTED takes a fresh snapshot per statement.
 *   3. the same under REPEATABLE READ — both shapes raise 40001 instead.
 *
 * The plan predicted that DO NOTHING would leave a concurrent duplicate unable
 * to name the row. It does not, at this app's isolation level. What it actually
 * costs is one extra round trip.
 */
async function race() {
  const org = (
    await client.query<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
      [`storm-race-${Date.now()}`],
    )
  ).rows[0].id;

  const cfg = {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  };

  const rows: Record<string, unknown>[] = [];

  try {
    // --- 1. no constraint at all -------------------------------------------
    //
    // A real table and a real pool, not a TEMP table on this connection. A temp
    // table is session-local, so it could only be raced by interleaving awaits
    // on one client — which pg serialises anyway. The bug being shown is two
    // CONNECTIONS interleaving, so it needs two connections.
    await client.query(`
      CREATE TABLE storm_race (
        id bigserial PRIMARY KEY,
        event_id text NOT NULL
      );
    `);

    const EVENTS = 200;
    const COPIES = 3;
    const ids = Array.from({ length: EVENTS }, (_, i) => `race-${i}`);

    const pool = new pg.Pool({ ...cfg, max: 20 });
    try {
      await Promise.all(
        ids.flatMap((eventId) =>
          Array.from({ length: COPIES }, async () => {
            // The two statements a developer writes before thinking about
            // concurrency. Sequentially it is correct. Concurrently both callers
            // see nothing and both insert.
            const seen = await pool.query(
              `SELECT id FROM storm_race WHERE event_id = $1`,
              [eventId],
            );
            if (seen.rowCount) return;
            await pool.query(`INSERT INTO storm_race (event_id) VALUES ($1)`, [
              eventId,
            ]);
          }),
        ),
      );
    } finally {
      await pool.end();
    }

    const written = Number(
      (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM storm_race`,
        )
      ).rows[0].n,
    );

    console.log('  1. check-then-insert, no unique constraint\n');
    console.log(
      `     ${EVENTS} events x ${COPIES} copies -> ${written} rows (expected ${EVENTS})`,
    );
    console.log(
      `     ${written - EVENTS} duplicate rows, 0 errors, every delivery a 201.`,
    );
    console.log(
      '     Nothing anywhere reports a problem. This is the bug the card is about.\n',
    );
    rows.push({
      experiment: 'no-constraint',
      events: EVENTS,
      copies: COPIES,
      written,
      duplicates: written - EVENTS,
    });

    await client.query(`DROP TABLE storm_race`);

    // --- 2 and 3. ON CONFLICT under two isolation levels --------------------
    const upsert = (action: string) =>
      `INSERT INTO conversations (org_id, status, provider_event_id)
       VALUES ($1::bigint, 'open', $2)
       ON CONFLICT (org_id, provider_event_id) WHERE provider_event_id IS NOT NULL
         ${action}
       RETURNING id, xmax = 0 AS created`;

    const SHAPES = {
      'DO NOTHING': 'DO NOTHING',
      'DO UPDATE':
        'DO UPDATE SET provider_event_id = EXCLUDED.provider_event_id',
    };

    console.log(
      '  2. two sessions, same event, one committing while the other waits\n',
    );
    console.log(
      '     shape       isolation         B insert    blocked   B follow-up SELECT',
    );

    for (const level of ['READ COMMITTED', 'REPEATABLE READ']) {
      for (const [label, action] of Object.entries(SHAPES)) {
        const eventId = `race-${level.replace(/ /g, '')}-${label.replace(/ /g, '')}-${Date.now()}`;
        const A = new pg.Client(cfg);
        const B = new pg.Client(cfg);
        await A.connect();
        await B.connect();

        await A.query('BEGIN');
        await B.query(`BEGIN ISOLATION LEVEL ${level}`);
        // B takes its snapshot before A writes, which is what makes this a race
        // rather than a sequence.
        await B.query('SELECT 1');

        await A.query(upsert(action), [org, eventId]);

        const startedAt = performance.now();
        const bInsert = B.query(upsert(action), [org, eventId]).then(
          (r) => ({ ok: true as const, rowCount: r.rowCount ?? 0 }),
          (e: { code?: string }) => ({
            ok: false as const,
            code: e.code ?? '?',
          }),
        );

        await new Promise((r) => setTimeout(r, 150));
        await A.query('COMMIT');

        const b = await bInsert;
        const blockedMs = performance.now() - startedAt;

        let followUp = '-';
        if (b.ok) {
          const f = await B.query(
            `SELECT id FROM conversations WHERE org_id = $1::bigint AND provider_event_id = $2`,
            [org, eventId],
          );
          followUp = `${f.rowCount} row${f.rowCount === 1 ? '' : 's'}`;
        }

        const insertResult = b.ok ? `${b.rowCount} row(s)` : `ERROR ${b.code}`;
        console.log(
          `     ${label.padEnd(11)} ${level.padEnd(17)} ${insertResult.padEnd(11)} ${blockedMs.toFixed(0).padStart(4)}ms   ${followUp}`,
        );
        rows.push({
          experiment: 'on-conflict',
          shape: label,
          isolation: level,
          insert: insertResult,
          blockedMs: Number(blockedMs.toFixed(0)),
          followUp,
        });

        await B.query('COMMIT').catch(() => undefined);
        await A.end();
        await B.end();
      }
    }

    console.log('');
    console.log('     Both shapes BLOCK — DO NOTHING does not skip the wait.');
    console.log(
      '     At READ COMMITTED the follow-up SELECT finds the row, because every',
    );
    console.log(
      '     statement takes a fresh snapshot and A has committed by then. So the',
    );
    console.log(
      '     two shapes differ in round trips and dead tuples, NOT in correctness.',
    );
    console.log(
      '     Raise the isolation level and both fail with 40001 instead — a',
    );
    console.log(
      '     different problem, whose fix is retrying the transaction.',
    );
  } finally {
    await client.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [
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

header(`storm ${subcommand}  api ${API}`);
if (armState) console.log(`  server arms  ${JSON.stringify(armState)}\n`);

await client.connect();

let rows: unknown = null;
let failures: string[] = [];

try {
  if (subcommand === 'key') {
    const key = await mintKey(ORG_ID, `manual-${Date.now()}`);
    console.log(
      `  org ${ORG_ID} api key (shown once, only the sha256 is stored):\n`,
    );
    console.log(`    ${key}\n`);
    rows = { org: ORG_ID, minted: true };
  } else if (subcommand === 'fire') {
    const out = await fire();
    rows = out.result;
    failures = out.failures;
  } else if (subcommand === 'redis-restart') {
    const out = await fire(FLUSH_AT);
    rows = out.result;
    // Deliberately NOT asserted. This subcommand exists to produce the failure,
    // so a red exit would say the instrument broke rather than that the guard
    // did. The numbers are the deliverable.
    console.log(
      `\n  guard wiped at ${FLUSH_AT}% — the errors and duplicates above are the finding, not a fault.`,
    );
  } else {
    rows = await race();
  }
} finally {
  await client.end();
}

record('storm', subcommand, { rows, arms: armState });

if (failures.length) {
  console.error(`\n  FAILED\n${failures.map((f) => `    ${f}`).join('\n')}\n`);
  process.exit(1);
}
