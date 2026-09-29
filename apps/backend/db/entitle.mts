// Drill 19's instrument: how long a plan change takes to reach the API, by every road a write can take.
// Runs in the container: `pnpm db:entitle <sub>`. See plans/2026-09-23_drill-19-entitlement-cache.md.
//
//   oob      an admin tool writes straight to Postgres; poll until the API notices
//   upgrade  the customer's view: 429s until the cache notices an upgrade (VIA api | oob)
//   race     the cache-aside fill race, forced: a stale fill lands after the DEL
//   ratio    hit ratio against per-org request rate at the running TTL
//   metrics  /metrics now, and the delta since the last call (bracket a k6 run with it)
//   lost     notify arm: kill the LISTEN connection, write during the gap

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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const subcommand = process.argv[2];
const SUBCOMMANDS = ['oob', 'upgrade', 'race', 'ratio', 'metrics', 'lost'];

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(`usage: node db/entitle.mts <${SUBCOMMANDS.join('|')}>`);
  process.exit(1);
}

const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const ROUNDS = knobNumber('ROUNDS', 5);
const POLL_MS = knobNumber('POLL_MS', 50);
const RATE = knobNumber('RATE', 10);
const AFTER = knobNumber('AFTER', 5);
const VIA = knob('VIA', 'oob');
const RATES = knobList('RATES', '0.1,1,10');
const SECONDS = knobNumber('SECONDS', 90);

// Must match src/entitlements/entitlements.service.ts. `race` exits 1 if the API ignores what it plants.
const entKey = (org: string) => `ent:v1:org:${org}`;
const rlKey = (org: string) => `rl:v1:ingest:org:${org}`;
const LISTENER = 'listen:entitlements';
const SNAPSHOT = '/tmp/entitle-metrics.json';

const client = pgClient();
const { Redis } = await import('ioredis');
const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  lazyConnect: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');

interface Lookup {
  plan: string | null;
  source: string;
  ageMs: number;
}

async function lookup(org: string): Promise<Lookup> {
  const response = await fetch(`${API}/entitlements`, {
    headers: { 'x-org-id': org },
  });
  if (!response.ok) throw new Error(`GET /entitlements -> ${response.status}`);
  return (await response.json()) as Lookup;
}

const orgs: string[] = [];

async function mintOrg(label: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
    [`entitle-${label}-${Date.now()}`],
  );
  orgs.push(rows[0].id);
  return rows[0].id;
}

async function mintKey(org: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const key = `dk_entitle-${org}-${Date.now()}`;
  await client.query(
    `INSERT INTO api_keys (org_id, name, key_hash) VALUES ($1, 'entitle', $2)`,
    [org, createHash('sha256').update(key).digest('hex')],
  );
  return key;
}

/** The admin tool. Owner connection, no API, no cache call. */
const writeOutOfBand = (org: string, plan: string) =>
  client.query(`UPDATE organizations SET plan = $2 WHERE id = $1`, [org, plan]);

/** Poll until the API serves `plan`. Returns ms since `since` and how many stale answers it saw. */
async function waitFor(
  org: string,
  plan: string,
  since: number,
  limitMs: number,
) {
  let stale = 0;
  for (;;) {
    const seen = await lookup(org);
    if (seen.plan === plan) return { ms: Date.now() - since, stale };
    stale += 1;
    if (Date.now() - since > limitMs) return { ms: NaN, stale };
    await sleep(POLL_MS);
  }
}

async function ttlSeconds(): Promise<number> {
  const arms = await serverArms(API);
  return Number(arms?.entitlementTtlS ?? 30);
}

// --------------------------------------------------------------------- oob

async function oob() {
  const ttlMs = (await ttlSeconds()) * 1000;
  const org = await mintOrg('oob');
  const rows: Record<string, number>[] = [];

  console.log(
    '  round  wait_ms  pttl_at_write_ms  staleness_ms  stale_reads  staleness-pttl',
  );
  for (let round = 1; round <= ROUNDS; round++) {
    await writeOutOfBand(org, 'free');
    await redis.del(entKey(org));
    await sleep(200);
    await lookup(org);

    // A random point in the key's life, or every round would measure the full TTL.
    const wait = Math.floor(Math.random() * ttlMs);
    await sleep(wait);

    const pttl = await redis.pttl(entKey(org));
    const t0 = Date.now();
    await writeOutOfBand(org, 'pro');
    const { ms, stale } = await waitFor(org, 'pro', t0, ttlMs + 5000);

    const row = { round, wait, pttl, ms, stale, error: ms - Math.max(0, pttl) };
    rows.push(row);
    console.log(
      `  ${String(round).padStart(5)}  ${String(wait).padStart(7)}  ${String(pttl).padStart(16)}  ${String(ms).padStart(12)}  ${String(stale).padStart(11)}  ${String(row.error).padStart(14)}`,
    );
  }

  const ms = rows.map((r) => r.ms);
  console.log(
    `\n  staleness min / median / max : ${n0(Math.min(...ms))} / ${n0(median(ms))} / ${n0(Math.max(...ms))} ms  (TTL ${n0(ttlMs)} ms)`,
  );
  console.log(
    `  |staleness - pttl| max       : ${n0(Math.max(...rows.map((r) => Math.abs(r.error))))} ms  (poll ${POLL_MS} ms)`,
  );
  return rows;
}

// ----------------------------------------------------------------- upgrade

async function upgrade() {
  if (VIA !== 'api' && VIA !== 'oob') throw new Error(`VIA must be api|oob`);
  const ttlMs = (await ttlSeconds()) * 1000;
  const org = await mintOrg(`upgrade-${VIA}`);
  const key = await mintKey(org);

  const start = Date.now();
  let i = 0;
  let trippedAt: number | null = null;
  let upgradedAt: number | null = null;
  let pttlAtUpgrade = NaN;
  let limitedAfter = 0;
  let firstOkAfter = NaN;
  const statuses: Record<number, number> = {};

  for (;;) {
    await sleep(Math.max(0, start + (i * 1000) / RATE - Date.now()));
    const response = await fetch(`${API}/ingest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ eventId: `entitle-${org}-${i}`, message: 'hi' }),
    });
    await response.arrayBuffer();
    i += 1;
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;

    if (response.status === 429 && trippedAt === null) {
      trippedAt = Date.now();
      console.log(
        `  +${n0(trippedAt - start)} ms  first 429 after ${i - 1} accepted`,
      );
    }

    if (
      trippedAt !== null &&
      upgradedAt === null &&
      Date.now() - trippedAt >= AFTER * 1000
    ) {
      pttlAtUpgrade = await redis.pttl(entKey(org));
      if (VIA === 'api') {
        const put = await fetch(`${API}/entitlements/plan`, {
          method: 'PUT',
          headers: { 'x-org-id': org, 'content-type': 'application/json' },
          body: JSON.stringify({ plan: 'pro' }),
        });
        if (!put.ok) throw new Error(`PUT /entitlements/plan -> ${put.status}`);
      } else {
        await writeOutOfBand(org, 'pro');
      }
      upgradedAt = Date.now();
      console.log(
        `  +${n0(upgradedAt - start)} ms  upgraded to pro via ${VIA}, entitlement key PTTL ${n0(pttlAtUpgrade)} ms`,
      );
      continue;
    }

    if (upgradedAt !== null) {
      if (response.status === 429) limitedAfter += 1;
      else if (response.status < 300) {
        firstOkAfter = Date.now() - upgradedAt;
        break;
      }
      if (Date.now() - upgradedAt > ttlMs + 5000) break;
    }
    if (Date.now() - start > 120_000)
      throw new Error('never tripped the limit');
  }

  console.log(
    `  +${n0(Date.now() - start)} ms  first accepted ingest after the upgrade`,
  );
  console.log(`\n  429s after the upgrade : ${limitedAfter}  (rate ${RATE}/s)`);
  console.log(`  upgrade -> first 2xx   : ${n0(firstOkAfter)} ms`);
  console.log(`  statuses               : ${JSON.stringify(statuses)}`);
  return {
    via: VIA,
    rate: RATE,
    pttlAtUpgrade,
    limitedAfter,
    firstOkAfter,
    statuses,
  };
}

// -------------------------------------------------------------------- race

async function race() {
  const ttlMs = (await ttlSeconds()) * 1000;
  const org = await mintOrg('race');
  await redis.del(entKey(org));

  console.log(
    '  A  reader misses, reads Postgres (free), and is descheduled before its SET',
  );
  const { rows } = await client.query<{
    plan: string;
    ingest_per_minute: number | null;
  }>(
    `SELECT o.plan, l.ingest_per_minute FROM organizations o JOIN plan_limits l USING (plan) WHERE o.id = $1`,
    [org],
  );
  const stale = {
    plan: rows[0].plan,
    ingestPerMinute: rows[0].ingest_per_minute,
    loadedAt: Date.now(),
  };

  console.log('  W  writer upgrades through the API: UPDATE, COMMIT, DEL');
  const put = await fetch(`${API}/entitlements/plan`, {
    method: 'PUT',
    headers: { 'x-org-id': org, 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'pro' }),
  });
  if (!put.ok) throw new Error(`PUT /entitlements/plan -> ${put.status}`);
  await sleep(200);

  console.log('  A  reader wakes up and SETs what it read, after the DEL');
  await redis.set(
    entKey(org),
    JSON.stringify(stale),
    'EX',
    Math.round(ttlMs / 1000),
  );
  const t0 = Date.now();

  const served = await lookup(org);
  console.log(`  API now serves plan=${served.plan} source=${served.source}`);
  const { ms, stale: reads } = await waitFor(org, 'pro', t0, ttlMs + 5000);
  console.log(
    `\n  stale for ${n0(ms)} ms after the invalidation (${reads} stale reads), TTL ${n0(ttlMs)} ms`,
  );

  const reproduced = served.plan === 'free' && served.source === 'hit';
  return {
    reproduced,
    servedPlan: served.plan,
    source: served.source,
    staleMs: ms,
  };
}

// ------------------------------------------------------------------- ratio

async function ratio() {
  const ttlS = await ttlSeconds();
  const rows: Record<string, number>[] = [];
  console.log(
    '  rate/s  requests  hits  misses  hit_ratio  predicted periodic       poisson RT/(1+RT)',
  );
  for (const rate of RATES) {
    const org = await mintOrg(`ratio-${rate}`);
    const start = Date.now();
    const counts: Record<string, number> = {};
    for (let i = 0; Date.now() - start < SECONDS * 1000; i++) {
      await sleep(Math.max(0, start + (i * 1000) / rate - Date.now()));
      const response = await fetch(`${API}/entitlements`, {
        headers: { 'x-org-id': org },
      });
      await response.arrayBuffer();
      const source = response.headers.get('x-entitlement') ?? 'none';
      counts[source] = (counts[source] ?? 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const hits = counts.hit ?? 0;
    const rt = rate * ttlS;
    const row = {
      rate,
      total,
      hits,
      misses: total - hits,
      measured: hits / total,
      // One miss per ceil(R*T) evenly spaced requests; the first request of a run always misses.
      periodic: rt < 1 ? 0 : 1 - Math.ceil(total / Math.ceil(rt)) / total,
      poisson: rt / (1 + rt),
    };
    rows.push(row);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    console.log(
      `  ${String(rate).padStart(6)}  ${String(total).padStart(8)}  ${String(hits).padStart(4)}  ${String(row.misses).padStart(6)}  ${pct(row.measured).padStart(9)}  ${pct(row.periodic).padStart(23)}  ${pct(row.poisson).padStart(17)}`,
    );
  }
  return rows;
}

// ----------------------------------------------------------------- metrics

async function metrics() {
  const text = await (await fetch(`${API}/metrics`)).text();
  const now: Record<string, number> = {};
  for (const [, name, value] of text.matchAll(
    /^([a-z_]+(?:\{[^}]*\})?) (\d+)$/gm,
  )) {
    now[name] = Number(value);
  }
  const hadSnapshot = existsSync(SNAPSHOT);
  const before: Record<string, number> = hadSnapshot
    ? (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, number>)
    : {};
  writeFileSync(SNAPSHOT, JSON.stringify(now));

  const delta = (name: string) => (now[name] ?? 0) - (before[name] ?? 0);
  const lookups = ['hit', 'miss', 'db', 'error'].map(
    (r) => [r, delta(`entitlement_lookups_total{result="${r}"}`)] as const,
  );
  const total = lookups.reduce((a, [, v]) => a + v, 0);
  const get = (r: string) => lookups.find(([k]) => k === r)![1];

  console.log(
    text
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  console.log(
    `\n  since ${hadSnapshot ? 'the last snapshot' : 'process start (no snapshot yet)'}:`,
  );
  console.log(
    `    lookups              : ${total}  ${lookups.map(([k, v]) => `${k}=${v}`).join(' ')}`,
  );
  if (total) {
    const dbReads = get('miss') + get('db') + get('error');
    console.log(
      `    hit ratio            : ${((get('hit') / total) * 100).toFixed(3)}%`,
    );
    console.log(
      `    DB reads per request : ${(dbReads / total).toFixed(5)}  (${dbReads} reads)`,
    );
  }
  return { now, before, total };
}

// -------------------------------------------------------------------- lost

async function lost() {
  const arms = await serverArms(API);
  if (arms?.entitlementCache !== 'notify') {
    throw new Error(
      `lost needs ENTITLEMENT_CACHE=notify; the server runs ${arms?.entitlementCache}`,
    );
  }
  const ttlMs = Number(arms.entitlementTtlS) * 1000;
  const org = await mintOrg('lost');
  const rows: Record<string, unknown>[] = [];

  for (let round = 1; round <= ROUNDS; round++) {
    for (const kill of [false, true]) {
      await writeOutOfBand(org, 'free');
      await sleep(300);
      await lookup(org);
      await sleep(Math.floor(Math.random() * (ttlMs / 2)));

      let killed = 0;
      if (kill) {
        const { rowCount } = await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`,
          [LISTENER],
        );
        killed = rowCount ?? 0;
        await sleep(100);
      }
      const pttl = await redis.pttl(entKey(org));
      const t0 = Date.now();
      await writeOutOfBand(org, 'pro');
      const { ms, stale } = await waitFor(org, 'pro', t0, ttlMs + 5000);
      rows.push({
        round,
        listener: kill ? 'killed' : 'up',
        killed,
        pttl,
        ms,
        stale,
      });
      console.log(
        `  round ${round}  listener ${kill ? `killed (${killed})` : 'up        '}  pttl ${String(pttl).padStart(6)} ms  staleness ${String(ms).padStart(6)} ms  stale reads ${stale}`,
      );
      await sleep(1500);
    }
  }
  return rows;
}

// -------------------------------------------------------------------- main

const armState = await serverArms(API);
header(`entitle ${subcommand}  api ${API}`);
if (armState) {
  console.log(
    `  server arms  entitlementCache=${armState.entitlementCache} entitlementTtlS=${armState.entitlementTtlS}\n`,
  );
}

await client.connect();
await redis.connect();

let rows: unknown = null;
let failed = '';

try {
  if (subcommand === 'oob') rows = await oob();
  else if (subcommand === 'upgrade') rows = await upgrade();
  else if (subcommand === 'race') {
    const out = await race();
    rows = out;
    if (!out.reproduced && armState?.entitlementCache !== 'off') {
      failed =
        'the planted stale value was not served — does the key or value shape still match the service?';
    }
  } else if (subcommand === 'ratio') rows = await ratio();
  else if (subcommand === 'metrics') rows = await metrics();
  else rows = await lost();
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
    await redis.del(entKey(org), rlKey(org));
  }
  await client.end();
  redis.disconnect();
}

record('entitle', subcommand, { rows, arms: armState });

if (failed) {
  console.error(`\n  FAILED  ${failed}\n`);
  process.exit(1);
}
