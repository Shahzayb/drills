// Card 14's instrument: what happens when two agents claim the same ticket.
//
//   pnpm db:claim fire    N concurrent claims on ONE row through the API — asserts
//   pnpm db:claim bench   conflict rate and successful-write throughput per level
//   pnpm db:claim race    two sessions, a controlled interleaving, no luck
//
// The same split as db/quota.mts, for the same reason. `fire` measures the
// ENDPOINT — routing, validation, RLS, the pool, the 409 body — on whichever arm
// the container is running. `bench` reimplements the three arm SHAPES in raw SQL
// against Postgres directly, and that duplication is the point twice over: it
// removes every layer that is not the mechanism, and it is the only way to
// INTERLEAVE the arms. `ASSIGN` is a module constant resolved at load, so an
// over-HTTP sweep would have to restart the container between arms — which is
// drill 07's "the arms differ in the checkout, not the variable" wearing a
// container's clothes.
//
// `fire` is a correctness proof, not a benchmark: it ASSERTS and exits 1.
//
//   200 responses          == 1               exactly one winner
//   409 responses          == REQUESTS - 1    everybody else was TOLD
//   5xx responses          == 0               a conflict is not an error
//   version               += 1                one write landed, not N
//   final assignee         == the 200's       the winner is who was told they won
//   peak in flight         == CONCURRENCY     the run really was concurrent
//
// Those assertions are arm-independent on purpose. `ASSIGN=lww` fails three of
// them, and that red run is the deliverable.
//
// Method, inherited from drill 05: cells INTERLEAVED in one sitting, medians not
// means, nothing under ~15% is a result.
//
// `.mts` and not `.ts`: apps/backend/package.json has no `type` field, so a
// `.ts` here would be CommonJS and this file's top-level await would be a syntax
// error. See plans/2026-08-30_instrument-typescript.md.
//
// Full reasoning: plans/2026-09-08_drill-14-optimistic-locking.md.

import pg from 'pg';
import {
  client as pgClient,
  header,
  knob,
  knobList,
  knobNumber,
  median,
  record,
  serverArms,
} from './lib/run.mts';

const subcommand = process.argv[2];
const SUBCOMMANDS = ['fire', 'bench', 'race'];
const USAGE = `usage: node db/claim.mts <${SUBCOMMANDS.join('|')}>`;

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

// `||` and not `??` throughout: the root script forwards these with
// `docker compose exec -e ORG_ID`, and an unset host variable arrives as the
// empty string, not as absent.
const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const ORG_ID = knob('ORG_ID', '1');
const REQUESTS = knobNumber('REQUESTS', 50);
const CONCURRENCY = knobNumber('CONCURRENCY', 50);
// The card's ladder: 2, 10 and 50 concurrent claimers on one row.
const LEVELS = knobList('LEVELS', '2,10,50');
const ROUNDS = knobNumber('ROUNDS', 3);
const SECONDS = knobNumber('SECONDS', 5);
const ONLY = knob('ONLY', '');

const client = pgClient();

const percentile = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    : 0;

const cfg = () => ({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

// --------------------------------------------------------------- fixtures

/**
 * The agents that race for the row.
 *
 * Minted rather than read out of the seed, and they have to be DISTINCT: the
 * claim rule is "unassigned, or already yours", so two claimers sharing a
 * membership id would both legally succeed on the pessimistic arm and the
 * exactly-one-winner assertion would be measuring the fixture instead of the
 * mechanism.
 *
 * Runs as the owner, which RLS exempts — the same reason db/seed.mts can write
 * across tenants.
 */
async function mintAgents(org: string, count: number, tag: string) {
  const { rows } = await client.query<{ id: string }>(
    `WITH people AS (
       INSERT INTO users (name)
       SELECT $2 || ' agent ' || g FROM generate_series(1, $3::int) g
       RETURNING id
     )
     INSERT INTO memberships (user_id, org_id, role)
     SELECT id, $1::bigint, 'editor' FROM people
     RETURNING id`,
    [org, tag, count],
  );
  return rows.map((r) => r.id);
}

/** One unassigned conversation for everyone to fight over. */
async function mintRow(org: string) {
  const { rows } = await client.query<{ id: string; version: number }>(
    `INSERT INTO conversations (org_id, status) VALUES ($1::bigint, 'open')
     RETURNING id, version`,
    [org],
  );
  return rows[0];
}

/** The row as it actually is, with the winner's name resolved. */
async function readRow(id: string) {
  const { rows } = await client.query<{
    assignee_id: string | null;
    version: number;
  }>(`SELECT assignee_id, version FROM conversations WHERE id = $1`, [id]);
  return rows[0];
}

/** Reverse dependency order. `usage_events` first only if ingest ever touched
 *  this row; it did not, so conversations then memberships then users. */
async function cleanup(conversationId: string | null, agentIds: string[]) {
  if (conversationId) {
    await client.query(`DELETE FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
  }
  if (agentIds.length) {
    await client.query(
      `WITH gone AS (
         DELETE FROM memberships WHERE id = ANY($1::bigint[])
         RETURNING user_id
       )
       DELETE FROM users WHERE id IN (SELECT user_id FROM gone)`,
      [agentIds],
    );
  }
}

// --------------------------------------------------------------------- fire

interface Outcome {
  status: number;
  ms: number;
  assigneeId: string;
}

/**
 * Fire one claim per agent, all naming the SAME version, with a bounded number
 * in flight.
 *
 * The shared version is the card's scenario stated exactly: every agent had the
 * inbox open, so every agent read the row at the same version. `inFlight` is
 * tracked and reported rather than assumed — undici pools connections per
 * origin, and a cap below CONCURRENCY would make this a sequential loop wearing
 * a concurrent one's name.
 */
async function fireAll(
  id: string,
  version: number,
  agentIds: string[],
): Promise<{ outcomes: Outcome[]; peakInFlight: number }> {
  const outcomes: Outcome[] = new Array(agentIds.length);
  let next = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= agentIds.length) return;

      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;

      const startedAt = performance.now();
      let status = 0;
      try {
        const response = await fetch(`${API}/conversations/${id}/assign`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-org-id': ORG_ID,
          },
          body: JSON.stringify({ assigneeId: agentIds[index], version }),
        });
        status = response.status;
        // Drained, not ignored: an unread body keeps the socket busy and the
        // next request opens another one, which quietly changes the concurrency
        // this instrument claims to be running at.
        await response.arrayBuffer();
      } catch {
        status = 0;
      }

      outcomes[index] = {
        status,
        ms: performance.now() - startedAt,
        assigneeId: agentIds[index],
      };
      inFlight--;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, agentIds.length) }, worker),
  );

  return { outcomes, peakInFlight };
}

async function fire() {
  const tag = `claim-${Date.now().toString(36)}`;
  console.log(`  tag ${tag}  (cleanup key, if this run dies)\n`);

  const agentIds = await mintAgents(ORG_ID, REQUESTS, tag);
  const row = await mintRow(ORG_ID);

  const startedAt = performance.now();
  const { outcomes, peakInFlight } = await fireAll(
    row.id,
    row.version,
    agentIds,
  );
  const wallMs = performance.now() - startedAt;

  const hist = new Map<number, number>();
  for (const o of outcomes) hist.set(o.status, (hist.get(o.status) ?? 0) + 1);
  const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const serverErrors = [...hist].reduce(
    (n, [status, count]) => (status >= 500 ? n + count : n),
    0,
  );

  const winners = outcomes.filter((o) => o.status === 200);
  const conflicts = hist.get(409) ?? 0;
  const after = await readRow(row.id);

  console.log(`  claimers            ${REQUESTS} distinct agents, one row`);
  console.log(
    `  concurrency         ${CONCURRENCY} requested, ${peakInFlight} peak in flight`,
  );
  console.log(
    `  wall clock          ${(wallMs / 1000).toFixed(2)}s  ${(REQUESTS / (wallMs / 1000)).toFixed(0)} req/s`,
  );
  console.log('');
  console.log(`  200 claimed         ${winners.length} (expected 1)`);
  console.log(`  409 conflict        ${conflicts} (expected ${REQUESTS - 1})`);
  console.log(`  400 bad request     ${hist.get(400) ?? 0}`);
  console.log(`  404 not found       ${hist.get(404) ?? 0}`);
  console.log(`  5xx                 ${serverErrors}`);
  console.log(`  transport failures  ${hist.get(0) ?? 0}`);
  console.log('');
  console.log(
    `  version             ${row.version} -> ${after.version} (expected ${row.version + 1})`,
  );
  console.log(`  final assignee      ${after.assignee_id ?? '(none)'}`);
  console.log(
    `  told they won       ${winners.map((w) => w.assigneeId).join(', ') || '(nobody)'}`,
  );
  console.log('');
  console.log(
    `  p50 / p95 / p99     ${median(sorted).toFixed(2)} / ${percentile(sorted, 0.95).toFixed(2)} / ${percentile(sorted, 0.99).toFixed(2)} ms`,
  );

  await cleanup(row.id, agentIds);
  console.log(`\n  cleaned up          1 conversation, ${REQUESTS} agents`);

  // Reported before they are enforced, so a red run still leaves every number
  // in the report directory.
  const failures: string[] = [];
  if (winners.length !== 1) {
    failures.push(
      `${winners.length} claimers were told they won — exactly 1 may be`,
    );
  }
  if (conflicts !== REQUESTS - 1) {
    failures.push(`${conflicts} conflicts, expected ${REQUESTS - 1}`);
  }
  if (serverErrors) failures.push(`${serverErrors} 5xx responses`);
  if (after.version !== row.version + 1) {
    failures.push(
      `version moved by ${after.version - row.version}, expected 1 — ` +
        `${after.version - row.version - 1} writes overwrote each other`,
    );
  }
  if (winners.length === 1 && after.assignee_id !== winners[0].assigneeId) {
    failures.push(
      `the row belongs to ${after.assignee_id}, but ${winners[0].assigneeId} was told it won`,
    );
  }
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
      claimed: winners.length,
      conflicts,
      badRequest: hist.get(400) ?? 0,
      notFound: hist.get(404) ?? 0,
      serverErrors,
      transportErrors: hist.get(0) ?? 0,
      versionBefore: row.version,
      versionAfter: after.version,
      finalAssignee: after.assignee_id,
      toldTheyWon: winners.map((w) => w.assigneeId),
      p50: Number(median(sorted).toFixed(2)),
      p95: Number(percentile(sorted, 0.95).toFixed(2)),
      p99: Number(percentile(sorted, 0.99).toFixed(2)),
    },
    failures,
  };
}

// -------------------------------------------------------------------- bench

type Arm = 'lww' | 'optimistic' | 'pessimistic';
const ARMS: Arm[] = ['lww', 'optimistic', 'pessimistic'];

/** What one attempt cost and whether it landed. `roundTrips` is counted rather
 *  than inferred, because the arms do not make the same number of them and that
 *  asymmetry is most of the answer. */
interface Attempt {
  won: boolean;
  version: number;
  roundTrips: number;
}

/**
 * One claim, in raw SQL, in the shape src/conversations/conversations.service.ts
 * issues it.
 *
 * `version` is what this worker last saw. On `pessimistic` it is unused: that
 * arm's read happens under the lock, which is the entire difference between the
 * two and the reason they cost different numbers of round trips.
 */
async function claim(
  // ClientBase, not PoolClient: `race` drives two standalone pg.Client sessions
  // and `bench` drives pooled ones, and both are the same three statements.
  c: pg.ClientBase,
  id: string,
  arm: Arm,
  // null is the release — handing the ticket back is not a claim.
  me: string | null,
  version: number,
): Promise<Attempt> {
  if (arm === 'pessimistic') {
    await c.query('BEGIN');
    try {
      const { rows } = await c.query<{
        assignee_id: string | null;
        version: number;
      }>(
        `SELECT assignee_id, version FROM conversations
          WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = rows[0];
      if (row.assignee_id !== null && row.assignee_id !== me) {
        await c.query('ROLLBACK');
        return { won: false, version: row.version, roundTrips: 3 };
      }
      const { rows: updated } = await c.query<{ version: number }>(
        `UPDATE conversations
            SET assignee_id = $2::bigint, version = version + 1, updated_at = now()
          WHERE id = $1
      RETURNING version`,
        [id, me],
      );
      await c.query('COMMIT');
      return { won: true, version: updated[0].version, roundTrips: 4 };
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  // lww and optimistic are both ONE statement, and the whole difference between
  // the bug and the fix is the guard below.
  const guard =
    arm === 'lww'
      ? ''
      : `AND version = $3
           AND ($2::bigint IS NULL OR assignee_id IS NULL OR assignee_id = $2::bigint)`;
  const params = arm === 'lww' ? [id, me] : [id, me, version];

  const { rows } = await c.query<{ version: number }>(
    `UPDATE conversations
        SET assignee_id = $2::bigint, version = version + 1, updated_at = now()
      WHERE id = $1
        ${guard}
  RETURNING version`,
    params,
  );

  return rows[0]
    ? { won: true, version: rows[0].version, roundTrips: 1 }
    : { won: false, version, roundTrips: 1 };
}

/** Hand the row back, so the next claimer has something legal to win. The same
 *  three shapes with a null assignee — a release is not a claim, so it asks only
 *  that the row has not moved. */
const release = (c: pg.ClientBase, id: string, arm: Arm, version: number) =>
  claim(c, id, arm, null, version);

/** The read an optimistic client is forced to make after a conflict. The other
 *  two arms never call this, which is the cost being measured. */
async function reread(c: pg.ClientBase, id: string): Promise<number> {
  const { rows } = await c.query<{ version: number }>(
    `SELECT version FROM conversations WHERE id = $1`,
    [id],
  );
  return rows[0].version;
}

interface Cell {
  arm: Arm;
  level: number;
  claims: number;
  conflicts: number;
  roundTrips: number;
  rps: number;
  conflictRate: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * One (arm, level) cell: `level` workers churning claim/release on ONE row for
 * SECONDS.
 *
 * Claim then release, because a one-shot race has a conflict rate of (N-1)/N by
 * arithmetic and measures nothing. Releasing what you just claimed keeps a
 * stream of LEGAL successful writes flowing over the same row, which is what
 * makes "successful-write throughput" a number rather than a tautology.
 */
async function benchOnce(
  id: string,
  agentIds: string[],
  arm: Arm,
  level: number,
): Promise<Cell> {
  await client.query(
    `UPDATE conversations SET assignee_id = NULL WHERE id = $1`,
    [id],
  );

  const pool = new pg.Pool({ ...cfg(), max: level });
  const durations: number[] = [];
  let claims = 0;
  let conflicts = 0;
  let roundTrips = 0;

  const deadline = performance.now() + SECONDS * 1000;
  const startedAt = performance.now();

  try {
    await Promise.all(
      Array.from({ length: level }, async (_, worker) => {
        const c = await pool.connect();
        const me = agentIds[worker % agentIds.length];
        try {
          let version = await reread(c, id);
          while (performance.now() < deadline) {
            const began = performance.now();
            const attempt = await claim(c, id, arm, me, version);
            roundTrips += attempt.roundTrips;

            if (attempt.won) {
              claims++;
              const back = await release(c, id, arm, attempt.version);
              roundTrips += back.roundTrips;
              // A release cannot legally fail — nobody else can hold a row this
              // worker just claimed. Re-reading if it does is what stops a
              // surprise turning into a worker that spins on a stale version
              // for the rest of the cell and reports it as contention.
              version = back.won ? back.version : await reread(c, id);
              if (!back.won) roundTrips++;
            } else {
              conflicts++;
              // The re-read is not overhead bolted on for the benchmark: an
              // optimistic client that retries with the version it already
              // knows is stale can only conflict again, forever.
              version = await reread(c, id);
              roundTrips++;
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
  const sorted = durations.sort((a, b) => a - b);
  const attempts = claims + conflicts;

  return {
    arm,
    level,
    claims,
    conflicts,
    roundTrips,
    rps: claims / (wallMs / 1000),
    conflictRate: attempts ? conflicts / attempts : 0,
    p50: median(sorted),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/**
 * Refuse a run that cannot be as concurrent as it claims.
 *
 * One worker holds one connection, so the widest level has to fit inside
 * max_connections alongside the app's pool. Without this, pg raises 53300 from
 * inside its connect path — and the quieter failure is worse: a pool that
 * silently serialises would report a conflict-free `lww` arm.
 */
async function assertConnectionHeadroom(widest: number): Promise<void> {
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

  if (free < widest) {
    console.error(
      `\n  the widest level is ${widest} and only ${free} connections are free\n` +
        `  (max_connections=${rows[0].max}, reserved=${rows[0].reserved}, in use=${rows[0].inUse}).\n\n` +
        `    PG_MAX_CONNECTIONS=200 docker compose up -d postgres_db\n\n` +
        `  or lower --levels. A run that cannot open the connections is not a\n` +
        `  quieter measurement, it is a different one.\n`,
    );
    process.exit(1);
  }
}

async function bench() {
  const widest = Math.max(...LEVELS);
  await assertConnectionHeadroom(widest);

  const tag = `claim-bench-${Date.now().toString(36)}`;
  const agentIds = await mintAgents(ORG_ID, widest, tag);
  const row = await mintRow(ORG_ID);
  const arms = ARMS.filter((a) => !ONLY || a.includes(ONLY));

  console.log(
    `  one row, ${SECONDS}s per cell, ${ROUNDS} rounds, median. claim then release.\n`,
  );
  console.log(
    '  arm           claimers    claims/s   conflict%   rt/write      p50      p95      p99',
  );

  // Round-robin over every cell, not cell-blocked: drill 05's rule is that arms
  // are interleaved because this laptop drifts, and finishing one arm before
  // starting the next is the shape that rule exists to forbid.
  const results = new Map<string, Cell[]>();
  for (let round = 0; round < ROUNDS; round++) {
    for (const level of LEVELS) {
      for (const arm of arms) {
        const key = `${arm}:${level}`;
        const runs = results.get(key) ?? [];
        runs.push(await benchOnce(row.id, agentIds, arm, level));
        results.set(key, runs);
      }
    }
  }

  const rows: Record<string, unknown>[] = [];
  for (const arm of arms) {
    for (const level of LEVELS) {
      const runs = results.get(`${arm}:${level}`)!;
      const pick = <K extends keyof Cell>(k: K) =>
        median(runs.map((r) => Number(r[k])));

      const out = {
        arm,
        level,
        claimsPerSecond: pick('rps'),
        conflictRate: pick('conflictRate'),
        roundTripsPerWrite: pick('roundTrips') / Math.max(1, pick('claims')),
        p50: pick('p50'),
        p95: pick('p95'),
        p99: pick('p99'),
      };
      rows.push(out);

      console.log(
        `  ${arm.padEnd(13)} ${String(level).padStart(8)} ${out.claimsPerSecond.toFixed(0).padStart(11)} ` +
          `${(out.conflictRate * 100).toFixed(1).padStart(11)} ${out.roundTripsPerWrite.toFixed(2).padStart(10)} ` +
          `${out.p50.toFixed(2).padStart(8)} ${out.p95.toFixed(2).padStart(8)} ${out.p99.toFixed(2).padStart(8)}`,
      );
    }
    console.log('');
  }

  console.log(
    '  claims/s is SUCCESSFUL writes. `lww` never conflicts and is never correct —\n' +
      '  it is the ceiling you are paying the other two arms to stay under.',
  );

  await cleanup(row.id, agentIds);
  return rows;
}

// --------------------------------------------------------------------- race

/**
 * The deterministic reproduction: two sessions, an interleaving this file
 * chooses, and no luck involved.
 *
 * Both agents read the row while it is unassigned — the card's scenario — and
 * then both click. What differs between the arms is only what B is told.
 */
async function race() {
  const tag = `claim-race-${Date.now().toString(36)}`;
  const agentIds = await mintAgents(ORG_ID, 2, tag);
  const row = await mintRow(ORG_ID);
  const rows: Record<string, unknown>[] = [];

  const reset = () =>
    client.query(
      `UPDATE conversations SET assignee_id = NULL, version = 1 WHERE id = $1`,
      [row.id],
    );

  try {
    console.log(
      '  two agents, one unassigned ticket, both with the inbox open at version 1\n',
    );
    console.log(
      '     arm           A read  B read   A claim      B claim        assignee  version  ok',
    );

    for (const arm of ARMS) {
      await reset();

      const A = new pg.Client(cfg());
      const B = new pg.Client(cfg());
      await A.connect();
      await B.connect();

      const readVersion = async (c: pg.Client) =>
        Number(
          (
            await c.query<{ version: number }>(
              `SELECT version FROM conversations WHERE id = $1`,
              [row.id],
            )
          ).rows[0].version,
        );

      // Both read BEFORE either writes. That is what makes this a race rather
      // than a sequence, and it is the whole of the scenario.
      const aVersion = await readVersion(A);
      const bVersion = await readVersion(B);

      const attempt = async (c: pg.Client, me: string, version: number) => {
        try {
          const result = await claim(c, row.id, arm, me, version);
          return result.won ? 'claimed' : 'conflict';
        } catch (e) {
          return `ERROR ${(e as { code?: string }).code ?? '?'}`;
        }
      };

      // Sequential writes, both reads already taken. That is the interleaving:
      // what makes this a race is not that the two writes overlap in time, it is
      // that B decided what to write from a value it read before A wrote.
      const a = await attempt(A, agentIds[0], aVersion);
      const b = await attempt(B, agentIds[1], bVersion);

      const after = await readRow(row.id);
      // One winner is the only right answer. Two `claimed` is the bug: both
      // agents walk away believing they own the ticket.
      const ok = [a, b].filter((x) => x === 'claimed').length === 1;

      console.log(
        `     ${arm.padEnd(13)} ${String(aVersion).padStart(6)} ${String(bVersion).padStart(7)}   ` +
          `${a.padEnd(10)} ${b.padEnd(12)} ${String(after.assignee_id).padStart(8)} ` +
          `${String(after.version).padStart(8)}  ${ok ? 'yes' : 'NO'}`,
      );
      rows.push({
        experiment: 'interleaving',
        arm,
        aVersion,
        bVersion,
        a,
        b,
        assignee: after.assignee_id,
        version: after.version,
        winnerIsA: after.assignee_id === agentIds[0],
        ok,
      });

      await A.end();
      await B.end();
    }

    console.log('');
    console.log(
      '     On `lww` both agents are told `claimed` and the row belongs to B. A is wrong,',
    );
    console.log(
      '     nothing errored, and no log line anywhere says so. That is the bug: not a',
    );
    console.log(
      '     crash, an agreement between the database and the application that one of the',
    );
    console.log('     two answers may quietly be a lie.');

    // --- 2. what the loser actually pays -----------------------------------
    //
    // Both arms refuse B. Only one of them makes B wait to find out, and the
    // wait is the thing the throughput chart is made of.
    console.log('');
    console.log('  2. how long the loser waits to be refused\n');
    console.log('     arm           B waited   while A held the row open');

    for (const arm of ['optimistic', 'pessimistic'] as Arm[]) {
      await reset();

      const A = new pg.Client(cfg());
      const B = new pg.Client(cfg());
      await A.connect();
      await B.connect();

      // A opens a transaction and takes the row, then sits on it — a request
      // that is slow for any of the ordinary reasons.
      await A.query('BEGIN');
      await A.query(
        `SELECT version FROM conversations WHERE id = $1 FOR UPDATE`,
        [row.id],
      );
      await A.query(
        `UPDATE conversations SET assignee_id = $2::bigint, version = version + 1
          WHERE id = $1`,
        [row.id, agentIds[0]],
      );

      const startedAt = performance.now();
      const pending = claim(B, row.id, arm, agentIds[1], 1).then(
        (r) => (r.won ? 'claimed' : 'conflict'),
        (e: { code?: string }) => `ERROR ${e.code ?? '?'}`,
      );

      const HELD_MS = 250;
      await new Promise((r) => setTimeout(r, HELD_MS));
      await A.query('COMMIT');

      const outcome = await pending;
      const waitedMs = performance.now() - startedAt;

      console.log(
        `     ${arm.padEnd(13)} ${waitedMs.toFixed(0).padStart(7)}ms   ${outcome} (A held it for ${HELD_MS}ms)`,
      );
      rows.push({
        experiment: 'wait',
        arm,
        heldMs: HELD_MS,
        waitedMs: Number(waitedMs.toFixed(1)),
        outcome,
      });

      await A.end();
      await B.end();
    }

    console.log('');
    console.log(
      '     Optimistic does not avoid the row lock — its UPDATE takes one too, and it',
    );
    console.log(
      '     waits behind an open transaction exactly as long. What it avoids is holding',
    );
    console.log(
      '     a lock across the human time between rendering a page and clicking a button.',
    );
  } finally {
    await cleanup(row.id, agentIds);
  }

  return rows;
}

// --------------------------------------------------------------------- main

const armState = await serverArms(API);

header(`claim ${subcommand}  api ${API}`);
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
  } else {
    rows = await race();
  }
} finally {
  await client.end();
}

record('claim', subcommand, { rows, arms: armState });

if (failures.length) {
  console.error(`\n  FAILED\n${failures.map((f) => `    ${f}`).join('\n')}\n`);
  process.exit(1);
}
