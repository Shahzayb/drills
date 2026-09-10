// Card 16's instrument: what a required column costs on a live 2.5M-row table.
//
//   pnpm db:schema naive      the whole migration in one transaction, timed and watched
//   pnpm db:schema safe       the same result in four steps, none of them blocking
//   pnpm db:schema backfill   the real column's one-time backfill, resumable
//   pnpm db:schema locks      two live sessions: which lock, held how long, blocking what
//   pnpm db:schema bench      the batch ladder, and the scan shape inside it
//   pnpm db:schema index      the stretch: CREATE INDEX vs CONCURRENTLY, and CIC's own failures
//
// THE SCRATCH COLUMN, AND WHY BOTH ARMS USE ONE
//
// `naive` and `safe` do not touch `conversations.last_message_at`. Each adds its
// own column — last_message_at_naive / last_message_at_safe — backfills it, and
// drops it. Three reasons:
//
//   1. The arms then differ ONLY in the sequencing of statements. Running the
//      naive arm against the shipped column and the safe arm against a fresh one
//      would compare two different amounts of work, which is drill 07's "the
//      arms differ in the checkout, not the variable" in another costume.
//   2. Every run starts from 2.5M NULLs, so the experiment is repeatable — on
//      either side of the migration that ships the real column.
//   3. The shipped column is never at risk from a measurement.
//
// A lock is taken on the TABLE, not on a column, so the blocking behaviour is
// identical to the real thing. That is the whole reason this substitution is
// honest rather than a simulation.
//
// Both arms give the scratch column `DEFAULT now()` as a separate statement,
// standing in for the code deploy that fills new rows. Without it a row inserted
// by live traffic during the backfill is a NULL the VALIDATE would then reject —
// which is a real failure mode, and it belongs to the ORDERING lesson rather
// than to every run of this instrument.
//
// WHAT THIS WRITES, AND WHAT IT LEAVES BEHIND
//
// An UPDATE of 2.5M rows writes 2.5M new tuples and leaves 2.5M dead ones.
// DROP COLUMN does not reclaim them — dropping a column is a catalog operation.
// So every run ends with a VACUUM, and a run killed half way has not done that.
// `pg_relation_size('conversations')` before and after is printed for exactly
// this reason: batching changes the LOCK, not the amount of garbage.
//
// `.mts` and not `.ts`: apps/backend/package.json has no `type` field, so a
// `.ts` here would be CommonJS and this file's top-level await would be a syntax
// error. See plans/2026-08-30_instrument-typescript.md.
//
// Full reasoning: plans/2026-09-10_drill-16-zero-downtime-migration.md.

import {
  client as pgClient,
  header,
  knob,
  knobList,
  knobNumber,
  record,
  serverArms,
} from './lib/run.mts';

const subcommand = process.argv[2];
const SUBCOMMANDS = ['naive', 'safe', 'backfill', 'locks', 'bench', 'index'];
const USAGE = `usage: node db/schema.mts <${SUBCOMMANDS.join('|')}>`;

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

// `||` and not `??` throughout, which is what knob() already does: the root
// script forwards these with `docker compose exec -e SHAPE`, and an unset host
// variable arrives inside the container as '' rather than as absent.
const ORG_ID = knob('ORG_ID', '1');
const SHAPE = knob('SHAPE', 'backfill');
const COLUMN = knob('COLUMN', 'last_message_at');
// 1,000 and 10ms, and both were measured rather than guessed. `pnpm db:schema
// bench` is where the numbers are: at 1,000 rows the planner keeps a Nested Loop
// over conversations_pkey, and at 10,000 it switches to a Hash Semi Join whose
// inner side is a sequential scan of all 2.5M rows — 134,001 rows/s against
// 41,791. The batch that is ten times bigger is three times slower, and it also
// holds its row locks for 250ms instead of 6.
//
// The pause moves with the batch. 50ms between 2,500 small batches is two
// minutes of sleeping to do nineteen seconds of work.
const BATCH = knobNumber('BATCH', 1_000);
const PAUSE_MS = knobNumber('PAUSE_MS', 10);
const SCAN = knob('SCAN', 'keyset');
const SAMPLE_MS = knobNumber('SAMPLE_MS', 250);
const WAIT = knobNumber('WAIT', 0);
const ABORT_AFTER = knobNumber('ABORT_AFTER', 0);
const BATCHES = knobList('BATCHES', '1000,10000,100000');
const ROWS = knobNumber('ROWS', 200_000);
const ONLY = knob('ONLY', '');

const SHAPES = ['backfill', 'rewrite', 'fastwrong'];
const SCANS = ['keyset', 'isnull'];

const API = process.env.BACKEND_INTERNAL_URL;

/** The DDL connection. Everything that takes a lock runs here. */
const client = pgClient();

/**
 * The watcher connection.
 *
 * A second one is not a nicety. The session running `ALTER TABLE` is inside that
 * statement for its whole duration and cannot answer a question about itself, so
 * a single-connection instrument can only report what a lock did AFTER it was
 * released — which is exactly the information an outage does not leave behind.
 *
 * pg_locks and pg_stat_activity are catalogs, so this connection is not itself
 * blocked by the table lock it is reporting on.
 */
const watcher = pgClient();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const n = (x: number) => x.toFixed(2);

// ------------------------------------------------------------- the watcher

interface LockRow {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  mode: string;
  granted: boolean;
  waited_ms: number | null;
  xact_ms: number | null;
  query: string;
}

interface Sample {
  /** ms since the watch started. */
  at: number;
  rows: LockRow[];
}

/**
 * Every lock on `conversations` right now, granted first.
 *
 * `pg_blocking_pids()` is the column that turns a list into an accusation: it
 * names, for a waiting backend, the backends whose locks it is waiting behind.
 * Reading pg_locks alone tells you a lock exists; this tells you what it cost.
 */
const LOCK_SQL = `
  SELECT a.pid,
         a.state,
         a.wait_event_type,
         a.wait_event,
         l.mode,
         l.granted,
         -- ::float8, not the bare EXTRACT: it returns numeric, and pg hands
         -- numeric back as a STRING for the same reason it does bigint. The
         -- report then formatted a string with toFixed and died.
         (EXTRACT(epoch FROM (clock_timestamp() - a.state_change)) * 1000)::float8 AS waited_ms,
         (EXTRACT(epoch FROM (clock_timestamp() - a.xact_start)) * 1000)::float8 AS xact_ms,
         left(regexp_replace(a.query, '\\s+', ' ', 'g'), 68) AS query,
         pg_blocking_pids(a.pid) AS blocked_by
    FROM pg_locks l
    JOIN pg_stat_activity a USING (pid)
   WHERE l.relation = 'conversations'::regclass
     AND a.pid <> pg_backend_pid()
   ORDER BY l.granted DESC, a.xact_start`;

function startWatching(intervalMs: number) {
  const samples: Sample[] = [];
  const started = process.hrtime.bigint();
  let running = true;

  const loop = (async () => {
    while (running) {
      try {
        const { rows } = await watcher.query<LockRow>(LOCK_SQL);
        samples.push({ at: ms(started), rows });
      } catch {
        // A sample that could not be taken is a missing sample, not a failed
        // run. The measurement being watched is the deliverable.
      }
      await sleep(intervalMs);
    }
  })();

  return async () => {
    running = false;
    await loop;
    return samples;
  };
}

/**
 * What the samples add up to: the worst moment, and who caused it.
 *
 * Printed rather than returned, because the interesting output is a table and
 * the interesting NUMBER — how many backends were queued behind one statement —
 * only exists across samples.
 */
function reportLocks(samples: Sample[]): Record<string, unknown> {
  const blocking = samples.filter((s) => s.rows.some((r) => !r.granted));

  if (!blocking.length) {
    console.log(`  pg_locks: ${samples.length} samples, nothing ever waited\n`);
    return { samples: samples.length, peakWaiters: 0 };
  }

  // The sample with the most waiters. Not the last one: an outage ends with
  // everything draining, and the drain is not the story.
  const worst = blocking.reduce((a, b) =>
    b.rows.filter((r) => !r.granted).length >
    a.rows.filter((r) => !r.granted).length
      ? b
      : a,
  );

  const waiters = worst.rows.filter((r) => !r.granted);
  const holders = worst.rows.filter((r) => r.granted);
  const longestWait = Math.max(
    ...blocking.flatMap((s) =>
      s.rows.filter((r) => !r.granted).map((r) => r.waited_ms ?? 0),
    ),
  );

  console.log(
    `  pg_locks: ${samples.length} samples, ${blocking.length} of them with a queue\n` +
      `  worst sample at +${n(worst.at)}ms — ${waiters.length} backend(s) waiting\n`,
  );
  console.table(
    worst.rows.map((r) => ({
      pid: r.pid,
      mode: r.mode,
      granted: r.granted,
      wait: r.wait_event_type ? `${r.wait_event_type}/${r.wait_event}` : '',
      'held/waited ms': n(r.waited_ms ?? 0),
      query: r.query,
    })),
  );

  const modes = [...new Set(waiters.map((r) => r.mode))].join(', ');
  console.log(
    `\n  the lock  : ${holders.map((h) => h.mode).join(', ') || '(none granted)'}\n` +
      `  it blocked: ${waiters.length} backend(s) queued for ${modes}\n` +
      `  longest wait observed: ${n(longestWait)}ms\n`,
  );

  return {
    samples: samples.length,
    samplesWithQueue: blocking.length,
    peakWaiters: waiters.length,
    heldModes: holders.map((h) => h.mode),
    queuedModes: [...new Set(waiters.map((r) => r.mode))],
    longestWaitMs: longestWait,
    worstSample: worst.rows,
  };
}

// ------------------------------------------------------------- table facts

const sizeOfTable = async (): Promise<number> => {
  const { rows } = await client.query<{ bytes: string }>(
    `SELECT pg_relation_size('conversations') AS bytes`,
  );
  return Number(rows[0].bytes);
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

const deadTuples = async (): Promise<number> => {
  const { rows } = await client.query<{ n: string }>(
    `SELECT coalesce(n_dead_tup, 0) AS n FROM pg_stat_user_tables
      WHERE relname = 'conversations'`,
  );
  return Number(rows[0]?.n ?? 0);
};

const nullsLeft = async (column: string): Promise<number> => {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM conversations WHERE ${column} IS NULL`,
  );
  return Number(rows[0].n);
};

/**
 * The value the backfill computes, as SQL.
 *
 * COALESCE to the conversation's own created_at, because a conversation with no
 * messages still has to satisfy NOT NULL and "never" is not a timestamp. That is
 * a product decision hiding in a migration, and it is the kind that gets made by
 * accident: the alternative — leave those rows NULL and keep the column
 * nullable — is a different feature.
 */
const TRUE_VALUE = (alias: string) =>
  `COALESCE((SELECT max(m.created_at) FROM messages m
              WHERE m.conversation_id = ${alias}.id), ${alias}.created_at)`;

/**
 * One keyset batch, as text, so `bench` can EXPLAIN the statement the backfill
 * actually runs rather than a hand-copied lookalike. The plan is the finding at
 * the top of the ladder, and a plan measured on different SQL is not a finding.
 */
const keysetBatch = (column: string) => `WITH page AS (
     SELECT id FROM conversations
      WHERE id > $1::uuid
      ORDER BY id
      LIMIT $2
   ), done AS (
     UPDATE conversations c
        SET ${column} = ${TRUE_VALUE('c')}
      WHERE c.id IN (SELECT id FROM page)
        AND c.${column} IS NULL
      RETURNING 1
   )
   SELECT (SELECT id FROM page ORDER BY id DESC LIMIT 1) AS next_cursor,
          (SELECT count(*) FROM page)::text AS scanned,
          (SELECT count(*) FROM done)::text AS updated`;

const addScratch = async (column: string) => {
  await client.query(
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ${column} timestamptz`,
  );
  await client.query(
    `ALTER TABLE conversations ALTER COLUMN ${column} SET DEFAULT now()`,
  );
};

/**
 * Drop the scratch column and reclaim what the run wrote.
 *
 * The VACUUM is not tidiness. Without it the dead tuples from a 2.5M-row UPDATE
 * stay in the heap, and every later drill's baseline reads a bigger table for no
 * reason anybody can find afterwards.
 */
const cleanupScratch = async (column: string) => {
  await client.query(`ALTER TABLE conversations DROP COLUMN IF EXISTS ${column}`);
  const before = await sizeOfTable();
  const t = process.hrtime.bigint();
  await client.query('VACUUM conversations');
  const took = ms(t);
  const after = await sizeOfTable();
  console.log(
    `  cleanup: dropped ${column}, VACUUM ${n(took)}ms, ` +
      `${mb(before)} -> ${mb(after)}\n`,
  );
};

// ---------------------------------------------------------------- backfill

interface BackfillResult {
  batches: number;
  updated: number;
  scanned: number;
  wallMs: number;
  workMs: number;
  pausedMs: number;
  slowestBatchMs: number;
  firstBatchMs: number;
  lastBatchMs: number;
}

/**
 * The batched backfill. One implementation, used by `safe`, `backfill` and
 * `bench` — a production step and a measured arm that are not the same code is
 * a measurement of something you do not ship.
 *
 * KEYSET, NOT `WHERE col IS NULL LIMIT n`
 *
 * The obvious batching is "give me n rows that still need doing". It is drill
 * 10's OFFSET finding wearing different clothes: with no index on the column,
 * every batch walks the primary key from the beginning and skips the rows it
 * already filled, so the work per batch grows as the run progresses. The keyset
 * walk carries a cursor instead and each batch starts where the last one
 * stopped. `SCAN=isnull` exists so the difference is measured rather than
 * asserted.
 *
 * `conversations.id` is uuidv7, so ordering by it is ordering by creation time,
 * and a cursor over it is stable under concurrent inserts — new rows sort after
 * the cursor and are handled by the column DEFAULT anyway.
 *
 * THE PAUSE
 *
 * Between batches, not inside them. It gives the row locks time to be taken by
 * somebody else, gives autovacuum a window to reclaim what the last batch made
 * dead, and keeps the WAL from arriving as one continuous wall. It is the
 * difference between a backfill that shares the database and one that owns it.
 */
async function backfill(
  column: string,
  {
    batch = BATCH,
    pauseMs = PAUSE_MS,
    scan = SCAN,
    limitRows = 0,
    onBatch,
  }: {
    batch?: number;
    pauseMs?: number;
    scan?: string;
    limitRows?: number;
    onBatch?: (updated: number, took: number) => void;
  } = {},
): Promise<BackfillResult> {
  const started = process.hrtime.bigint();
  const out: BackfillResult = {
    batches: 0,
    updated: 0,
    scanned: 0,
    wallMs: 0,
    workMs: 0,
    pausedMs: 0,
    slowestBatchMs: 0,
    firstBatchMs: 0,
    lastBatchMs: 0,
  };

  let cursor = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    const t = process.hrtime.bigint();

    // ONE statement per batch, and therefore one transaction per batch. Two
    // statements would need an explicit BEGIN and would hold row locks across a
    // round trip for no reason.
    //
    // The cursor is `ORDER BY id DESC LIMIT 1` and not `max(id)`: there is no
    // max() aggregate for uuid, in Postgres 18 or anywhere else. The page is
    // already ordered and already small, so the sort is free.
    const { rows } = await (scan === 'isnull'
      ? client.query<{ next_cursor: string | null; scanned: string; updated: string }>(
          `WITH page AS (
             SELECT id FROM conversations
              WHERE ${column} IS NULL
              ORDER BY id
              LIMIT $1
           ), done AS (
             UPDATE conversations c
                SET ${column} = ${TRUE_VALUE('c')}
              WHERE c.id IN (SELECT id FROM page)
              RETURNING 1
           )
           SELECT NULL::uuid AS next_cursor,
                  (SELECT count(*) FROM page)::text AS scanned,
                  (SELECT count(*) FROM done)::text AS updated`,
          [batch],
        )
      : client.query<{ next_cursor: string | null; scanned: string; updated: string }>(
          keysetBatch(column),
          [cursor, batch],
        ));

    const took = ms(t);
    const scanned = Number(rows[0].scanned);
    const updated = Number(rows[0].updated);

    out.batches += 1;
    out.scanned += scanned;
    out.updated += updated;
    out.workMs += took;
    out.slowestBatchMs = Math.max(out.slowestBatchMs, took);
    if (out.batches === 1) out.firstBatchMs = took;
    out.lastBatchMs = took;
    onBatch?.(updated, took);

    // The keyset walk ends when the page is empty; the IS NULL walk ends when
    // nothing is left to update. Two different terminating conditions, because
    // the two shapes are asking two different questions.
    if (scan === 'isnull' ? updated === 0 : scanned === 0) break;
    if (rows[0].next_cursor) cursor = rows[0].next_cursor;
    if (limitRows && out.scanned >= limitRows) break;

    if (pauseMs > 0) {
      await sleep(pauseMs);
      out.pausedMs += pauseMs;
    }
  }

  out.wallMs = ms(started);
  return out;
}

const printBackfill = (label: string, r: BackfillResult) => {
  console.log(
    `  ${label}\n` +
      `    batches           : ${r.batches} of ${BATCH.toLocaleString()}\n` +
      `    rows updated      : ${r.updated.toLocaleString()}\n` +
      `    wall / work / paused: ${n(r.wallMs)} / ${n(r.workMs)} / ${r.pausedMs} ms\n` +
      `    rows/s (work only): ${n(r.updated / (r.workMs / 1000))}\n` +
      `    first / last / slowest batch: ${n(r.firstBatchMs)} / ${n(r.lastBatchMs)} / ${n(r.slowestBatchMs)} ms\n`,
  );
};

// ------------------------------------------------------------------- naive

/**
 * The migration everybody writes first, in one transaction.
 *
 * The lock is taken by the FIRST statement and released by COMMIT. That is the
 * entire lesson: the outage is not the length of the UPDATE, it is the length of
 * the migration. Nothing here is a mistake in isolation — every statement is the
 * right statement — and put in one transaction they are an outage.
 */
async function naive(): Promise<Record<string, unknown>> {
  if (!SHAPES.includes(SHAPE)) {
    console.error(`SHAPE must be one of ${SHAPES.join(' | ')}`);
    process.exit(1);
  }

  const column = `${COLUMN}_naive`;
  await client.query(`ALTER TABLE conversations DROP COLUMN IF EXISTS ${column}`);

  if (WAIT) {
    console.log(`  waiting ${WAIT}s so the load has a measured window open...\n`);
    await sleep(WAIT * 1000);
  }

  const { rows: pidRows } = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const ddlPid = pidRows[0].pid;

  const sizeBefore = await sizeOfTable();
  const deadBefore = await deadTuples();
  const stop = startWatching(SAMPLE_MS);

  // Cancelled from the WATCHER connection, because the one being cancelled is
  // busy. This is the card's "the rollback is worse than the outage" made
  // runnable: the transaction unwinds cleanly and every byte of WAL it wrote is
  // still WAL, every tuple it superseded is still dead.
  let cancelled = false;
  const canceller = ABORT_AFTER
    ? setTimeout(() => {
        cancelled = true;
        void watcher.query('SELECT pg_cancel_backend($1)', [ddlPid]);
      }, ABORT_AFTER * 1000)
    : null;

  const statements: { sql: string; label: string }[] =
    SHAPE === 'rewrite'
      ? [
          {
            label: 'ADD COLUMN NOT NULL DEFAULT clock_timestamp()  [volatile]',
            sql: `ALTER TABLE conversations ADD COLUMN ${column} timestamptz
                    NOT NULL DEFAULT clock_timestamp()`,
          },
        ]
      : SHAPE === 'fastwrong'
        ? [
            {
              label: 'ADD COLUMN NOT NULL DEFAULT now()  [non-volatile]',
              sql: `ALTER TABLE conversations ADD COLUMN ${column} timestamptz
                      NOT NULL DEFAULT now()`,
            },
          ]
        : [
            {
              label: 'ADD COLUMN (nullable)',
              sql: `ALTER TABLE conversations ADD COLUMN ${column} timestamptz`,
            },
            {
              label: 'SET DEFAULT now()',
              sql: `ALTER TABLE conversations ALTER COLUMN ${column} SET DEFAULT now()`,
            },
            {
              label: 'UPDATE ... 2.5M rows',
              sql: `UPDATE conversations c SET ${column} = ${TRUE_VALUE('c')}`,
            },
            {
              label: 'SET NOT NULL',
              sql: `ALTER TABLE conversations ALTER COLUMN ${column} SET NOT NULL`,
            },
          ];

  const timings: { statement: string; ms: string }[] = [];
  const wholeTxn = process.hrtime.bigint();
  let failure: string | null = null;

  try {
    await client.query('BEGIN');
    for (const s of statements) {
      const t = process.hrtime.bigint();
      await client.query(s.sql);
      timings.push({ statement: s.label, ms: n(ms(t)) });
    }
    await client.query('COMMIT');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await client.query('ROLLBACK').catch(() => undefined);
  } finally {
    if (canceller) clearTimeout(canceller);
  }

  const heldMs = ms(wholeTxn);
  const samples = await stop();

  console.log(`  shape: ${SHAPE}   ddl backend pid: ${ddlPid}\n`);
  console.table(timings);
  console.log(
    `\n  ONE transaction, held for ${n(heldMs)}ms` +
      `${failure ? ` — then FAILED: ${failure}` : ''}\n` +
      `  Every statement above ran inside it, so the ACCESS EXCLUSIVE taken by\n` +
      `  the first was held until the last one committed.\n`,
  );

  const lockReport = reportLocks(samples);

  // The `fastwrong` arm's whole point: it did not block anybody and it is wrong.
  let wrongness: Record<string, unknown> | null = null;
  if (SHAPE === 'fastwrong' && !failure) {
    const { rows } = await client.query<{
      distinct_values: string;
      disagreeing: string;
      total: string;
    }>(
      `SELECT count(DISTINCT ${column})::text AS distinct_values,
              count(*) FILTER (WHERE ${column} <> updated_at)::text AS disagreeing,
              count(*)::text AS total
         FROM conversations`,
    );
    wrongness = rows[0];
    console.log(
      `  it did not block anything, and it is wrong:\n` +
        `    distinct values across ${Number(rows[0].total).toLocaleString()} rows : ${rows[0].distinct_values}\n` +
        `    rows disagreeing with updated_at              : ${Number(rows[0].disagreeing).toLocaleString()}\n` +
        `  (updated_at is the oracle here: db/seed.mts BUILDS it as the last\n` +
        `   message's timestamp, so for seeded rows the two must agree.)\n`,
    );
  }

  const deadAfter = await deadTuples();
  const sizeAfter = await sizeOfTable();
  console.log(
    `  heap ${mb(sizeBefore)} -> ${mb(sizeAfter)}   ` +
      `n_dead_tup ${deadBefore.toLocaleString()} -> ${deadAfter.toLocaleString()}` +
      `${cancelled ? '   (cancelled mid-run, and the garbage is still here)' : ''}\n`,
  );

  await cleanupScratch(column);

  return {
    shape: SHAPE,
    heldMs,
    cancelled,
    failure,
    statements: timings,
    locks: lockReport,
    wrongness,
    heapBefore: sizeBefore,
    heapAfter: sizeAfter,
    deadBefore,
    deadAfter,
  };
}

// -------------------------------------------------------------------- safe

/**
 * The same column, arrived at without ever holding a lock long enough to matter.
 *
 * Four steps, four transactions. Steps 1, 3 and 4 are catalog-only. Step 2 is
 * the only long one and it takes ROW EXCLUSIVE — the same lock an ordinary
 * INSERT takes, which is to say it conflicts with nothing the application does.
 */
async function safe(): Promise<Record<string, unknown>> {
  const column = `${COLUMN}_safe`;
  const constraint = `conversations_${column}_nn`;

  await client.query(
    `ALTER TABLE conversations DROP CONSTRAINT IF EXISTS ${constraint}`,
  );
  await client.query(`ALTER TABLE conversations DROP COLUMN IF EXISTS ${column}`);

  if (WAIT) {
    console.log(`  waiting ${WAIT}s so the load has a measured window open...\n`);
    await sleep(WAIT * 1000);
  }

  const sizeBefore = await sizeOfTable();
  const deadBefore = await deadTuples();
  const stop = startWatching(SAMPLE_MS);
  const wholeRun = process.hrtime.bigint();
  const steps: { step: string; lock: string; ms: string }[] = [];

  const step = async (label: string, lock: string, fn: () => Promise<void>) => {
    const t = process.hrtime.bigint();
    await fn();
    steps.push({ step: label, lock, ms: n(ms(t)) });
  };

  // 1. Expand. Two catalog writes, each its own transaction, each holding
  //    ACCESS EXCLUSIVE for microseconds. A lock you take is not an outage; a
  //    lock you HOLD is.
  await step('ADD COLUMN + SET DEFAULT', 'ACCESS EXCLUSIVE (µs)', async () => {
    await addScratch(column);
  });

  // 2. The backfill. Many transactions, none of them long.
  let filled: BackfillResult | null = null;
  await step(
    `backfill, ${BATCH.toLocaleString()}-row batches, ${PAUSE_MS}ms pause`,
    'ROW EXCLUSIVE, per batch',
    async () => {
      filled = await backfill(column);
    },
  );

  // 3. Declare it required, without checking the past.
  //
  // Behind a lock_timeout, because the catalog write is microseconds and the
  // QUEUE for it is not. A waiting ACCESS EXCLUSIVE blocks everything that
  // arrives after it, so this statement's real risk is not its own duration —
  // it is autovacuum, which the backfill above just gave 2.5M reasons to run.
  await step('ADD CONSTRAINT ... NOT VALID', 'ACCESS EXCLUSIVE (µs)', async () => {
    await client.query(`SET lock_timeout = '3s'`);
    try {
      await client.query(
        `ALTER TABLE conversations
           ADD CONSTRAINT ${constraint} NOT NULL ${column} NOT VALID`,
      );
    } finally {
      await client.query(`RESET lock_timeout`);
    }
  });

  // 4. Check the past, blocking nobody. SHARE UPDATE EXCLUSIVE conflicts with
  //    VACUUM, ANALYZE and CREATE INDEX CONCURRENTLY — and with no read and no
  //    write the application makes.
  await step('VALIDATE CONSTRAINT', 'SHARE UPDATE EXCLUSIVE', async () => {
    await client.query(
      `ALTER TABLE conversations VALIDATE CONSTRAINT ${constraint}`,
    );
  });

  const totalMs = ms(wholeRun);
  const samples = await stop();

  console.table(steps);
  const longest = Math.max(
    ...steps
      .filter((s) => s.lock.startsWith('ACCESS EXCLUSIVE'))
      .map((s) => Number(s.ms)),
  );
  console.log(
    `\n  ${n(totalMs)}ms end to end, and the longest ACCESS EXCLUSIVE lock in it\n` +
      `  was ${n(longest)}ms.\n`,
  );

  if (filled) printBackfill('backfill', filled);

  const lockReport = reportLocks(samples);

  const left = await nullsLeft(column);
  const { rows: check } = await client.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
    [constraint],
  );
  console.log(
    `  ${column}: ${left} NULLs left, constraint validated: ${check[0]?.convalidated}\n`,
  );

  const deadAfter = await deadTuples();
  const sizeAfter = await sizeOfTable();
  console.log(
    `  heap ${mb(sizeBefore)} -> ${mb(sizeAfter)}   ` +
      `n_dead_tup ${deadBefore.toLocaleString()} -> ${deadAfter.toLocaleString()}\n` +
      `  (the same garbage the naive arm made — batching changes the LOCK, not\n` +
      `   the amount of rewriting.)\n`,
  );

  await client.query(
    `ALTER TABLE conversations DROP CONSTRAINT IF EXISTS ${constraint}`,
  );
  await cleanupScratch(column);

  return {
    totalMs,
    longestAccessExclusiveMs: longest,
    steps,
    backfill: filled,
    locks: lockReport,
    nullsLeft: left,
    heapBefore: sizeBefore,
    heapAfter: sizeAfter,
    deadBefore,
    deadAfter,
  };
}

// -------------------------------------------------- the real one, run once

/**
 * The production step: fill `conversations.last_message_at` for every row that
 * predates the column.
 *
 * NOT a migration, deliberately. node-pg-migrate holds a session advisory lock
 * for the length of a run, so a backfill inside one blocks every other deploy
 * for as long as it takes — and a deploy pipeline that times out half way
 * through leaves a migration ledger nobody can reason about. A backfill is an
 * operation. It is resumable, it can be run twice, and it can be stopped.
 *
 * Resumable because of the `IS NULL` guard inside the UPDATE, not because
 * anything is remembered between runs: a second run walks the same keyset and
 * skips every row that already has a value. That also makes it safe against
 * rows whose value is deliberately not the aggregate — an imported conversation
 * carries the CSV's timestamp, and re-running this must not overwrite it.
 */
async function runBackfill(): Promise<Record<string, unknown>> {
  const before = await nullsLeft(COLUMN);
  console.log(`  ${COLUMN}: ${before.toLocaleString()} rows to fill\n`);

  let done = 0;
  const result = await backfill(COLUMN, {
    onBatch: (updated) => {
      done += updated;
      if (done && done % 500_000 < BATCH) {
        console.log(`    ${done.toLocaleString()} filled...`);
      }
    },
  });

  printBackfill(`backfill of ${COLUMN}`, result);

  const after = await nullsLeft(COLUMN);

  // The oracle. db/seed.mts builds updated_at as the last message's timestamp,
  // so for every seeded row the backfill's own aggregate has to land on the same
  // value. A backfill with no check is a backfill you are trusting.
  const { rows } = await client.query<{ disagreeing: string }>(
    `SELECT count(*)::text AS disagreeing FROM conversations
      WHERE ${COLUMN} <> updated_at`,
  );

  console.log(
    `  NULLs ${before.toLocaleString()} -> ${after.toLocaleString()}\n` +
      `  rows where ${COLUMN} <> updated_at: ${Number(rows[0].disagreeing).toLocaleString()}\n` +
      `  (seeded rows must agree — the seed BUILDS updated_at from the last\n` +
      `   message. Rows written since by an assign or a status change will not.)\n`,
  );

  return { before, after, disagreeing: Number(rows[0].disagreeing), ...result };
}

// ------------------------------------------------------------------- locks

/**
 * Two live sessions, a chosen interleaving, and no luck involved.
 *
 * The same shape as `db:storm race` and `db:claim race`. What it answers is the
 * card's first question — which statement takes which lock, and what that lock
 * actually stops — by taking the lock and then trying the thing.
 */
async function locks(): Promise<Record<string, unknown>> {
  const other = pgClient();
  await other.connect();

  const column = `${COLUMN}_locks`;
  const constraint = `conversations_${column}_nn`;
  await client.query(`ALTER TABLE conversations DROP COLUMN IF EXISTS ${column}`);

  const results: Record<string, unknown>[] = [];

  /**
   * Hold `hold` open in session A, try `attempt` in session B, and report
   * whether B got through.
   *
   * B is given a statement_timeout rather than being left to hang: an
   * experiment that can wedge the instrument is not an experiment you run
   * twice.
   */
  const probe = async (
    holdLabel: string,
    hold: string[],
    attemptLabel: string,
    attempt: string,
  ) => {
    await client.query('BEGIN');
    for (const sql of hold) await client.query(sql);

    const { rows: held } = await watcher.query<{ mode: string }>(
      `SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        WHERE l.relation = 'conversations'::regclass AND l.granted
          AND a.application_name IS NOT NULL AND a.pid = $1`,
      [(await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid],
    );

    await other.query("SET statement_timeout = '1500ms'");
    const t = process.hrtime.bigint();
    let blocked = false;
    let waitedFor: string[] = [];
    try {
      const inFlight = other.query(attempt);
      // Give it long enough to be seen queueing before the timeout fires.
      await sleep(400);
      const { rows: waiting } = await watcher.query<{
        mode: string;
        granted: boolean;
      }>(
        `SELECT l.mode, l.granted FROM pg_locks l
          WHERE l.relation = 'conversations'::regclass AND NOT l.granted`,
      );
      waitedFor = waiting.map((w) => w.mode);
      await inFlight;
    } catch {
      blocked = true;
    }
    const took = ms(t);

    await client.query('ROLLBACK');
    await other.query('SET statement_timeout = 0').catch(() => undefined);

    const row = {
      holding: holdLabel,
      'lock held': [...new Set(held.map((h) => h.mode))].join(', '),
      attempting: attemptLabel,
      blocked: blocked ? 'YES' : 'no',
      'queued for': waitedFor.join(', ') || '-',
      ms: n(took),
    };
    results.push(row);
    return row;
  };

  console.log(
    `  Each row: session A holds a lock inside an open transaction, session B\n` +
      `  tries something, and B has a 1500ms statement_timeout. "blocked: YES"\n` +
      `  means B never got through.\n`,
  );

  await probe(
    'ALTER TABLE ADD COLUMN',
    [`ALTER TABLE conversations ADD COLUMN ${column} timestamptz`],
    'SELECT one row',
    `SELECT id FROM conversations LIMIT 1`,
  );

  await probe(
    'ALTER TABLE ADD COLUMN',
    [`ALTER TABLE conversations ADD COLUMN ${column} timestamptz`],
    'INSERT one row',
    `INSERT INTO conversations (org_id, status, provider_event_id, last_message_at)
     VALUES (${ORG_ID}, 'open', 'probe-' || gen_random_uuid(), now())`,
  );

  await probe(
    'UPDATE (the backfill statement)',
    [`UPDATE conversations SET status = status WHERE id = (SELECT id FROM conversations LIMIT 1)`],
    'SELECT one row',
    `SELECT id FROM conversations LIMIT 1`,
  );

  await probe(
    'UPDATE (the backfill statement)',
    [`UPDATE conversations SET status = status WHERE id = (SELECT id FROM conversations LIMIT 1)`],
    'INSERT one row',
    `INSERT INTO conversations (org_id, status, provider_event_id, last_message_at)
     VALUES (${ORG_ID}, 'open', 'probe-' || gen_random_uuid(), now())`,
  );

  // The pay-off row. VALIDATE holds SHARE UPDATE EXCLUSIVE for its whole scan
  // and blocks neither of the two things an application does.
  await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ${column} timestamptz`);
  await client.query(`UPDATE conversations SET ${column} = now() WHERE ${column} IS NULL`);
  await client.query(
    `ALTER TABLE conversations ADD CONSTRAINT ${constraint} NOT NULL ${column} NOT VALID`,
  );

  await probe(
    'VALIDATE CONSTRAINT',
    [`ALTER TABLE conversations VALIDATE CONSTRAINT ${constraint}`],
    'INSERT one row',
    `INSERT INTO conversations (org_id, status, provider_event_id, last_message_at, ${column})
     VALUES (${ORG_ID}, 'open', 'probe-' || gen_random_uuid(), now(), now())`,
  );

  await probe(
    'VALIDATE CONSTRAINT',
    [`ALTER TABLE conversations VALIDATE CONSTRAINT ${constraint}`],
    'VACUUM is what it DOES block',
    `ANALYZE conversations`,
  );

  console.table(results);

  console.log(
    `\n  The conflict table this walks a corner of (Postgres docs, "Explicit\n` +
      `  Locking"). ACCESS EXCLUSIVE is the only mode that conflicts with\n` +
      `  ACCESS SHARE, which is the mode a plain SELECT takes — which is why it\n` +
      `  is the only one that can stop a read:\n\n` +
      `    ACCESS SHARE             SELECT\n` +
      `    ROW EXCLUSIVE            INSERT / UPDATE / DELETE\n` +
      `    SHARE                    CREATE INDEX          blocks writes, not reads\n` +
      `    SHARE UPDATE EXCLUSIVE   VACUUM, ANALYZE, VALIDATE CONSTRAINT,\n` +
      `                             CREATE INDEX CONCURRENTLY   blocks neither\n` +
      `    ACCESS EXCLUSIVE         ALTER TABLE, DROP, TRUNCATE   blocks everything\n`,
  );

  await client.query(
    `ALTER TABLE conversations DROP CONSTRAINT IF EXISTS ${constraint}`,
  );
  await client.query(`ALTER TABLE conversations DROP COLUMN IF EXISTS ${column}`);
  await client.query(
    `DELETE FROM conversations WHERE provider_event_id LIKE 'probe-%'`,
  );
  await other.end();

  return { probes: results };
}

// ------------------------------------------------------------------- bench

/**
 * The batch ladder, and the scan shape inside it.
 *
 * Bounded by ROWS rather than run to completion: the question is rows/s and how
 * a batch size changes it, and answering that eight times over 2.5M rows would
 * take an hour and leave 20M dead tuples behind.
 *
 * PAUSE_MS is forced to 0 here. A pause is a policy about sharing the database,
 * and leaving it in would put the same constant into every cell and flatten the
 * thing being measured.
 */
/**
 * The top join node of one batch's plan, taken inside a rolled-back transaction
 * so the measurement leaves nothing. `DDL is transactional in Postgres` is what
 * makes this possible — the same trick db/explain.mts uses to price an index.
 */
async function topJoinNode(column: string, batch: number): Promise<string> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) ${keysetBatch(column)}`,
      ['00000000-0000-0000-0000-000000000000', batch],
    );
    const line = rows
      .map((r) => r['QUERY PLAN'].trim())
      .find((l) => /Join|Nested Loop/.test(l));
    return line ?? '(no join node)';
  } finally {
    await client.query('ROLLBACK');
  }
}

async function bench(): Promise<Record<string, unknown>> {
  const cells: Record<string, unknown>[] = [];

  for (const scan of SCANS) {
    for (const batch of BATCHES) {
      const label = `${scan} / ${batch.toLocaleString()}`;
      if (ONLY && !label.includes(ONLY)) continue;

      const column = `${COLUMN}_bench`;
      await client.query(
        `ALTER TABLE conversations DROP COLUMN IF EXISTS ${column}`,
      );
      await addScratch(column);

      // What the planner chose for the FIRST batch, read before the cell runs
      // and rolled back. The ladder is not a straight line and this column is
      // why: past some batch size the page stops being a page and Postgres
      // sequential-scans the whole table to find it.
      const plan = scan === 'keyset' ? await topJoinNode(column, batch) : '-';

      const r = await backfill(column, {
        batch,
        pauseMs: 0,
        scan,
        limitRows: ROWS,
      });

      cells.push({
        scan,
        batch: batch.toLocaleString(),
        batches: r.batches,
        rows: r.updated.toLocaleString(),
        'rows/s': n(r.updated / (r.workMs / 1000)),
        'first batch ms': n(r.firstBatchMs),
        'last batch ms': n(r.lastBatchMs),
        // The number that separates the two scan shapes: a keyset walk's batches
        // cost the same at the end as at the start, an IS NULL walk's do not.
        drift: `${n((r.lastBatchMs / (r.firstBatchMs || 1)) * 100 - 100)}%`,
        plan,
      });
      console.table([cells[cells.length - 1]]);

      await client.query(
        `ALTER TABLE conversations DROP COLUMN IF EXISTS ${column}`,
      );
      // Between cells, not at the end. Each cell leaves ROWS dead tuples, and
      // without this the later cells scan past every earlier cell's garbage —
      // an ordering effect that reads exactly like a batch-size effect.
      await client.query('VACUUM conversations');
    }
  }

  console.log('');
  console.table(cells);
  console.log(
    `\n  ROWS=${ROWS.toLocaleString()} per cell, PAUSE_MS forced to 0.\n` +
      `  "drift" is the last batch against the first, in the same run.\n`,
  );

  const t = process.hrtime.bigint();
  await client.query('VACUUM conversations');
  console.log(`  VACUUM ${n(ms(t))}ms\n`);

  return { rows: ROWS, cells };
}

// ------------------------------------------------------------------- index

/**
 * The stretch: the same index built two ways, and the failure CONCURRENTLY has
 * that a plain build does not.
 *
 * The index is NOT shipped. `(org_id, last_message_at DESC, id DESC)` would be a
 * second 118MB copy of drill 09's inbox index for a column nothing sorts by, and
 * pricing it here is the point rather than a step towards adding it.
 */
async function index(): Promise<Record<string, unknown>> {
  const other = pgClient();
  await other.connect();

  const name = 'conversations_org_last_message_idx';
  const definition = `(org_id, ${COLUMN} DESC, id DESC)`;
  const drop = async () => {
    await client.query(`DROP INDEX IF EXISTS ${name}`);
  };
  await drop();

  const out: Record<string, unknown> = {};
  const runs: Record<string, unknown>[] = [];

  /**
   * One write, timed, from another session, while a build is in progress.
   *
   * Timed and not just checked: a build that finishes in 890ms lets a write
   * through with a 2s timeout, and "yes" then hides that the write spent 274ms
   * queueing. Whether it SUCCEEDED is the wrong question — an index build that
   * doubles write latency is an incident either way.
   */
  const timedWrite = async () => {
    await other.query("SET statement_timeout = '5000ms'");
    const t = process.hrtime.bigint();
    const ok = await other
      .query(
        `INSERT INTO conversations (org_id, status, provider_event_id, last_message_at)
         VALUES (${ORG_ID}, 'open', 'probe-' || gen_random_uuid(), now())`,
      )
      .then(() => true)
      .catch(() => false);
    const took = ms(t);
    await other.query('SET statement_timeout = 0').catch(() => undefined);
    return { ok, took };
  };

  const sizeOfIndex = async () => {
    const { rows } = await client.query<{ bytes: string | null }>(
      `SELECT pg_relation_size(to_regclass($1)) AS bytes`,
      [name],
    );
    return Number(rows[0].bytes ?? 0);
  };

  // --- 1. plain CREATE INDEX: what it blocks while it builds.
  if (!ONLY || 'plain'.includes(ONLY)) {
    const stop = startWatching(SAMPLE_MS);
    const t = process.hrtime.bigint();

    // The probe runs against the SAME build, from another session, while it is
    // in progress. Timing it after the fact would measure an unlocked table.
    const probe = (async () => {
      await sleep(50);
      const readAt = process.hrtime.bigint();
      const readOk = await other
        .query('SELECT id FROM conversations LIMIT 1')
        .then(() => true)
        .catch(() => false);
      const readMs = ms(readAt);
      const write = await timedWrite();
      return { readOk, readMs, write };
    })();

    await client.query(`CREATE INDEX ${name} ON conversations ${definition}`);
    const took = ms(t);
    const { readOk, readMs, write } = await probe;
    const samples = await stop();

    runs.push({
      build: 'CREATE INDEX',
      ms: n(took),
      size: mb(await sizeOfIndex()),
      'a read took': `${n(readMs)}ms${readOk ? '' : ' (FAILED)'}`,
      'a write took': `${n(write.took)}ms${write.ok ? '' : ' (FAILED)'}`,
    });
    out.plain = { ms: took, readOk, readMs, write, locks: reportLocks(samples) };
    await drop();
  }

  // --- 2. CREATE INDEX CONCURRENTLY: slower, and it lets writes through.
  if (!ONLY || 'concurrent'.includes(ONLY)) {
    const t = process.hrtime.bigint();
    const probe = (async () => {
      await sleep(50);
      const readAt = process.hrtime.bigint();
      const readOk = await other
        .query('SELECT id FROM conversations LIMIT 1')
        .then(() => true)
        .catch(() => false);
      const readMs = ms(readAt);
      const write = await timedWrite();
      return { readOk, readMs, write };
    })();

    await client.query(
      `CREATE INDEX CONCURRENTLY ${name} ON conversations ${definition}`,
    );
    const took = ms(t);
    const { readOk, readMs, write } = await probe;

    runs.push({
      build: 'CREATE INDEX CONCURRENTLY',
      ms: n(took),
      size: mb(await sizeOfIndex()),
      'a read took': `${n(readMs)}ms${readOk ? '' : ' (FAILED)'}`,
      'a write took': `${n(write.took)}ms${write.ok ? '' : ' (FAILED)'}`,
    });
    out.concurrent = { ms: took, readOk, readMs, write };
    await drop();
  }

  console.table(runs);

  // --- 3. The failure mode CONCURRENTLY has and a plain build does not.
  //
  // A plain CREATE INDEX runs in a transaction, so a failure rolls it back and
  // leaves nothing. CONCURRENTLY cannot run in a transaction at all, and a
  // failed build leaves an index with indisvalid = false: invisible to the
  // planner, and still maintained on every INSERT and UPDATE. You pay for it and
  // it answers nothing.
  if (!ONLY || 'invalid'.includes(ONLY)) {
    console.log(
      `\n  Interrupting a CONCURRENTLY build (the failure a plain build cannot have):\n`,
    );
    const { rows: pidRows } = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    // Early, because this table is small enough to build in under a second.
    // The point is to land the cancel INSIDE the build, not to time it.
    const cancelIn = setTimeout(() => {
      void watcher.query('SELECT pg_cancel_backend($1)', [pidRows[0].pid]);
    }, 250);

    let cancelledWith = 'it finished before the cancel landed';
    try {
      await client.query(
        `CREATE INDEX CONCURRENTLY ${name} ON conversations ${definition}`,
      );
    } catch (error) {
      cancelledWith = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(cancelIn);
    }

    const { rows: invalid } = await client.query<{
      indexrelid: string;
      indisvalid: boolean;
    }>(
      `SELECT indexrelid::regclass::text AS indexrelid, indisvalid
         FROM pg_index WHERE NOT indisvalid`,
    );

    console.log(
      `    build ended with: ${cancelledWith}\n` +
        `    invalid indexes now present: ${invalid.length ? invalid.map((i) => i.indexrelid).join(', ') : 'none'}\n` +
        `    find them with:\n` +
        `      SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;\n` +
        `    recover by dropping and rebuilding — REINDEX CONCURRENTLY also works.\n`,
    );
    out.invalidAfterCancel = invalid;
    await drop();
  }

  // --- 4. The second one: CONCURRENTLY waits for transactions it did not start.
  //
  // It has to. The build needs a point at which no transaction can still be
  // holding a snapshot older than the index, so it waits for every transaction
  // open when it begins — including one that is doing nothing at all. A plain
  // CREATE INDEX takes SHARE and queues normally; this waits without holding
  // anything, which is why it looks like a hang rather than a lock.
  if (!ONLY || 'idle'.includes(ONLY)) {
    console.log(`  A CONCURRENTLY build behind one idle-in-transaction session:\n`);
    const { rows: buildPidRows } = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const buildPid = buildPidRows[0].pid;
    // It has to WRITE. A transaction that has only read holds a virtual
    // transaction id, and the first version of this experiment watched a
    // CONCURRENTLY build sail straight past one. An INSERT assigns a real xid,
    // which is what the build's two wait phases actually wait for.
    await other.query('BEGIN');
    await other.query(
      `INSERT INTO conversations (org_id, status, provider_event_id, last_message_at)
       VALUES (${ORG_ID}, 'open', 'probe-' || gen_random_uuid(), now())`,
    );

    const t = process.hrtime.bigint();
    const build = client
      .query(`CREATE INDEX CONCURRENTLY ${name} ON conversations ${definition}`)
      .then(() => ({ ok: true, ms: ms(t) }))
      .catch((e: Error) => ({ ok: false, ms: ms(t), error: e.message }));

    await sleep(2000);
    // BY PID, not by query text: an idle backend keeps its last query in
    // pg_stat_activity, so matching on the text can report a finished build as
    // though it were the running one.
    const { rows: waiting } = await watcher.query<{
      wait_event_type: string | null;
      wait_event: string | null;
      state: string | null;
    }>(
      `SELECT wait_event_type, wait_event, state FROM pg_stat_activity
        WHERE pid = $1`,
      [buildPid],
    );
    console.log(
      `    after 2s the build is: ${JSON.stringify(waiting[0] ?? null)}\n` +
        `    (a plain CREATE INDEX would be running by now — this is waiting for\n` +
        `     a transaction that is doing nothing.)\n`,
    );

    await other.query('COMMIT');
    const result = await build;
    console.log(
      `    once the idle transaction committed: ${JSON.stringify(result)}\n`,
    );
    out.behindIdleTransaction = { observed: waiting[0] ?? null, result };
    await drop();
  }

  await client.query(
    `DELETE FROM conversations WHERE provider_event_id LIKE 'probe-%'`,
  );
  await other.end();

  out.runs = runs;
  return out;
}

// --------------------------------------------------------------------- main

const armState = await serverArms(API);

header(`schema ${subcommand}`);
if (armState) console.log(`  server arms  ${JSON.stringify(armState)}\n`);

await client.connect();
await watcher.connect();

let rows: unknown = null;

try {
  if (subcommand === 'naive') rows = await naive();
  else if (subcommand === 'safe') rows = await safe();
  else if (subcommand === 'backfill') rows = await runBackfill();
  else if (subcommand === 'locks') rows = await locks();
  else if (subcommand === 'bench') rows = await bench();
  else rows = await index();
} finally {
  await watcher.end();
  await client.end();
}

record('schema', subcommand, { rows, arms: armState });
