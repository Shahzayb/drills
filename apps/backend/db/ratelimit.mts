// Drill 21's instrument: two attacks on the ingest limiter, each scored against the contract B + r·T.
// Runs in the container: `pnpm db:ratelimit <sub>`. See plans/2026-10-06_drill-21-rate-limit-burst-boundary.md.
//
//   boundary    an opener, then a burst just before the 60s boundary and another just after it
//   concurrent  REQUESTS at once on a fresh key
//
// Each round mints an org on PLAN with an API key and deletes both afterwards. The arm is the server's
// (`RATE_LIMIT=<arm> docker compose up -d nest_server`); this reads it from /info.

import {
  client as pgClient,
  header,
  knob,
  knobNumber,
  median,
  record,
  serverArms,
} from './lib/run.mts';
import { createHash } from 'node:crypto';

const subcommand = process.argv[2];
const SUBCOMMANDS = ['boundary', 'concurrent'];

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(`usage: node db/ratelimit.mts <${SUBCOMMANDS.join('|')}>`);
  process.exit(1);
}

const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const PLAN = knob('PLAN', 'basic');
const ROUNDS = knobNumber('ROUNDS', subcommand === 'boundary' ? 1 : 3);
const BURST = knobNumber('BURST', 0);
const GAP_MS = knobNumber('GAP_MS', 1000);
const REQUESTS = knobNumber('REQUESTS', 2000);
const COLD = knob('COLD', '0') === '1';

// Must match src/entitlements/entitlements.service.ts.
const WINDOW_S = 60;
const entKey = (org: string) => `ent:v1:org:${org}`;
const rlKeys = (org: string) =>
  ['fixed', 'fixed-rmw', 'bucket-rmw', 'bucket'].map(
    (arm) => `rl:v2:ingest:${arm}:org:${org}`,
  );

const client = pgClient();
const { Redis } = await import('ioredis');
const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  lazyConnect: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

interface Shot {
  status: number;
  sentAt: number;
  doneAt: number;
  metered: boolean;
  entitlement: string;
}

/** Limiter-admitted: it wrote a decision and did not refuse. A 5xx after that still got through it. */
const admittedBy = (shots: Shot[]) =>
  shots.filter((s) => s.metered && s.status !== 429).length;

const orgs: string[] = [];

async function mint(): Promise<{ org: string; key: string; limit: number }> {
  const { rows } = await client.query<{ id: string; limit: number | null }>(
    `WITH o AS (INSERT INTO organizations (name, plan) VALUES ($1, $2) RETURNING id, plan)
     SELECT o.id, l.ingest_per_minute AS limit FROM o JOIN plan_limits l USING (plan)`,
    [`ratelimit-${Date.now()}`, PLAN],
  );
  const { id: org, limit } = rows[0];
  orgs.push(org);
  if (limit === null) throw new Error(`plan ${PLAN} is unlimited`);
  const key = `dk_ratelimit-${org}-${Date.now()}`;
  await client.query(
    `INSERT INTO api_keys (org_id, name, key_hash) VALUES ($1, 'ratelimit', $2)`,
    [org, createHash('sha256').update(key).digest('hex')],
  );
  return { org, key, limit };
}

/** Fills the entitlement key, so the attack measures the limiter and not a cold cache. */
async function warm(org: string): Promise<void> {
  const response = await fetch(`${API}/entitlements`, {
    headers: { 'x-org-id': org },
  });
  await response.arrayBuffer();
}

async function shoot(key: string, id: string): Promise<Shot> {
  const sentAt = Date.now();
  try {
    const response = await fetch(`${API}/ingest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ eventId: id, message: 'rate limit probe' }),
    });
    // Drained, so the socket is free and the burst's concurrency is what it claims.
    await response.arrayBuffer();
    return {
      status: response.status,
      sentAt,
      doneAt: Date.now(),
      metered: response.headers.has('ratelimit'),
      entitlement: response.headers.get('x-entitlement') ?? '-',
    };
  } catch {
    return {
      status: 0,
      sentAt,
      doneAt: Date.now(),
      metered: false,
      entitlement: '-',
    };
  }
}

let shotId = 0;
const burst = (org: string, key: string, n: number) =>
  Promise.all(
    Array.from({ length: n }, () => shoot(key, `rl-${org}-${shotId++}`)),
  );

async function decisions(): Promise<{ allowed: number; limited: number }> {
  const text = await (await fetch(`${API}/metrics`)).text();
  const read = (name: string) =>
    Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN);
  return {
    allowed: read('ingest_rate_limit_allowed_total'),
    limited: read('ingest_rate_limited_total'),
  };
}

/** What the arm's key holds after the attack. On an rmw arm it is far below what was admitted. */
async function stored(org: string): Promise<string> {
  const key = `rl:v2:ingest:${armState?.rateLimit ?? '?'}:org:${org}`;
  if ((await redis.type(key)) === 'hash') {
    return JSON.stringify(await redis.hgetall(key));
  }
  return (await redis.get(key)) ?? '(none)';
}

/** Admitted against B + r·T, with B = L and r = L/60 per second. T is the attack's outer span. */
function score(shots: Shot[], limit: number) {
  const spanMs =
    Math.max(...shots.map((s) => s.doneAt)) -
    Math.min(...shots.map((s) => s.sentAt));
  const contract = limit + (limit / WINDOW_S) * (spanMs / 1000);
  const admitted = admittedBy(shots);
  return { admitted, spanMs, contract, error: admitted / contract - 1 };
}

function tally(shots: Shot[]) {
  const by = (pick: (s: Shot) => string) =>
    shots.reduce<Record<string, number>>((acc, s) => {
      acc[pick(s)] = (acc[pick(s)] ?? 0) + 1;
      return acc;
    }, {});
  return {
    statuses: by((s) => String(s.status)),
    entitlement: by((s) => s.entitlement),
    unmetered: shots.filter((s) => !s.metered).length,
  };
}

// ----------------------------------------------------------------- boundary

async function boundary() {
  const rows: Record<string, unknown>[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const { org, key, limit } = await mint();
    const size = BURST || limit;
    await warm(org);

    const before = await decisions();
    const opener = await shoot(key, `rl-${org}-opener`);
    // An anchored window opens on the opener's arrival. A clock-aligned one would be public anyway.
    const edge = opener.sentAt + WINDOW_S * 1000;
    console.log(
      `  round ${round}  org ${org}  limit ${limit}  opener ${opener.status}  boundary in ${WINDOW_S}s`,
    );

    await sleep(edge - GAP_MS - Date.now() - 1500);
    await warm(org);
    await sleep(edge - GAP_MS - Date.now());
    const first = await burst(org, key, size);
    await sleep(Math.max(0, edge + GAP_MS - Date.now()));
    const second = await burst(org, key, size);
    const after = await decisions();

    const s = score([...first, ...second], limit);
    const row = {
      round,
      limit,
      burst: size,
      firstAdmitted: admittedBy(first),
      secondAdmitted: admittedBy(second),
      firstEndsBeforeEdgeMs: edge - Math.max(...first.map((x) => x.doneAt)),
      ...s,
      ...tally([...first, ...second]),
      metrics: {
        allowed: after.allowed - before.allowed - 1,
        limited: after.limited - before.limited,
      },
    };
    rows.push(row);
    console.log(
      `    burst 1 at edge-${GAP_MS}ms: ${row.firstAdmitted}/${size} admitted, done ${row.firstEndsBeforeEdgeMs}ms before the edge`,
    );
    console.log(
      `    burst 2 at edge+${GAP_MS}ms: ${row.secondAdmitted}/${size} admitted`,
    );
    console.log(
      `    admitted ${s.admitted} in ${(s.spanMs / 1000).toFixed(2)}s  contract ${s.contract.toFixed(1)}  error ${pct(s.error)}`,
    );
    console.log(
      `    statuses ${JSON.stringify(row.statuses)}  unmetered ${row.unmetered}  /metrics allowed ${row.metrics.allowed} limited ${row.metrics.limited}\n`,
    );
  }
  return rows;
}

// --------------------------------------------------------------- concurrent

async function concurrent() {
  const rows: Record<string, unknown>[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const { org, key, limit } = await mint();
    if (COLD) await redis.del(entKey(org));
    else await warm(org);

    const before = await decisions();
    const shots = await burst(org, key, REQUESTS);
    const after = await decisions();
    const state = await stored(org);

    const s = score(shots, limit);
    const row = {
      round,
      limit,
      requests: REQUESTS,
      stored: state,
      ...s,
      ...tally(shots),
      metrics: {
        allowed: after.allowed - before.allowed,
        limited: after.limited - before.limited,
      },
    };
    rows.push(row);
    console.log(
      `  round ${round}  org ${org}  limit ${limit}  admitted ${s.admitted}/${REQUESTS} in ${(s.spanMs / 1000).toFixed(2)}s  contract ${s.contract.toFixed(1)}  error ${pct(s.error)}`,
    );
    console.log(
      `    statuses ${JSON.stringify(row.statuses)}  x-entitlement ${JSON.stringify(row.entitlement)}  unmetered ${row.unmetered}  /metrics allowed ${row.metrics.allowed} limited ${row.metrics.limited}`,
    );
    console.log(`    stored after: ${state}\n`);
  }
  return rows;
}

// -------------------------------------------------------------------- main

const armState = await serverArms(API);
header(`ratelimit ${subcommand}  api ${API}`);
console.log(`  server arm  rateLimit=${armState?.rateLimit ?? '?'}\n`);

await client.connect();
await redis.connect();

let rows: Record<string, unknown>[] = [];
try {
  rows = subcommand === 'boundary' ? await boundary() : await concurrent();
  const errors = rows.map((r) => r.error as number);
  console.log(
    `  ${armState?.rateLimit ?? '?'} ${subcommand}: admitted median ${median(rows.map((r) => r.admitted as number))}  error median ${pct(median(errors))}  min ${pct(Math.min(...errors))}  max ${pct(Math.max(...errors))}`,
  );
} finally {
  for (const org of orgs) {
    for (const table of [
      'usage_events',
      'usage_counters',
      'messages',
      'conversations',
      'api_keys',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [org]);
    }
    await client.query(`DELETE FROM organizations WHERE id = $1`, [org]);
    await redis.del(entKey(org), ...rlKeys(org));
  }
  await client.end();
  redis.disconnect();
}

record('ratelimit', subcommand, { rows, arms: armState });
