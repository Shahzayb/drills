// Drill 20's instrument: an expired hot key under load, with the load, the database and the expiry
// on one clock. Runs in the container: `pnpm db:stampede <sub>`.
// See plans/2026-09-29_drill-20-cache-stampede.md.
//
//   run   open-model load on one org's stats; force the key's expiry mid-run; count the recomputes
//   herd  load across many orgs; delete all their keys at once; watch the refills stay in step
//
// Needs pg_stat_statements: `PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db`.

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
const SUBCOMMANDS = ['run', 'herd'];

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(`usage: node db/stampede.mts <${SUBCOMMANDS.join('|')}>`);
  process.exit(1);
}

const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const isRun = subcommand === 'run';
// Each subcommand reads only its own knobs, so the header and the report directory never name one it ignored.
const ORG = isRun ? knob('ORG_ID', '150') : '';
const ORGS = isRun ? '' : knob('ORGS', '11-110');
const RATE = knobNumber('RATE', 500);
const SECONDS = knobNumber('SECONDS', isRun ? 40 : 60);
const EXPIRE_AT = isRun ? knobNumber('EXPIRE_AT', 20) : 0;
const FLUSH_AT = isRun ? 0 : knobNumber('FLUSH_AT', 5);
const BUCKET_MS = knobNumber('BUCKET_MS', 100);

/** The open model's safety valve, k6's `dropped_iterations`: past this, a request is counted, not sent. */
const MAX_IN_FLIGHT = 2_000;

// Must match src/search/search.service.ts.
const statsKey = (org: string) => `stats:v1:org:${org}`;

// The stats aggregate and the entitlement read, as pg_stat_statements normalises them. pgss counts
// only statements that finished; a stats transaction that failed shows up as a rollback instead.
const SAMPLE_SQL = `
  SELECT (SELECT coalesce(sum(calls), 0)::int FROM pg_stat_statements
           WHERE query LIKE '%AS last_message_at%' AND query LIKE '%FROM messages m%') AS stats,
         (SELECT coalesce(sum(calls), 0)::int FROM pg_stat_statements
           WHERE query LIKE '%JOIN plan_limits l USING (plan)%') AS ent,
         (SELECT count(*)::int FROM pg_stat_activity
           WHERE backend_type = 'client backend' AND state = 'active'
             AND query LIKE '%AS last_message_at%' AND pid <> pg_backend_pid()) AS active,
         (SELECT xact_rollback::int FROM pg_stat_database
           WHERE datname = current_database()) AS rollbacks`;

const sampler = pgClient();
const { Redis } = await import('ioredis');
const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  db: Number(process.env.REDIS_DB || 0),
  lazyConnect: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const ms = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const bar = (n: number, cap = 60) =>
  n > cap ? `${'#'.repeat(cap)}+` : '#'.repeat(n);

interface Result {
  t: number;
  ms: number;
  status: number;
  source: string;
  ent: string;
}

interface Sample {
  t: number;
  stats: number;
  ent: number;
  active: number;
  rollbacks: number;
}

interface Timeline {
  results: Result[];
  samples: Sample[];
  dropped: number[];
  marks: Record<string, number>;
}

/** A Prometheus counter off /metrics, by exact series name. */
async function metrics(): Promise<Record<string, number>> {
  const text = await (await fetch(`${API}/metrics`)).text();
  const out: Record<string, number> = {};
  for (const [, name, value] of text.matchAll(
    /^(stats_\w+(?:\{result="\w+"\})?) (\d+)$/gm,
  )) {
    out[name] = Number(value);
  }
  return out;
}

async function getStats(org: string): Promise<Response> {
  const response = await fetch(`${API}/messages/stats`, {
    headers: { 'x-org-id': org },
  });
  await response.arrayBuffer();
  return response;
}

/**
 * Fires RATE requests a second whether or not earlier ones came back: an open model. A closed
 * model (k6 VUs) slows its own arrival rate when the server slows, and so cannot show a pile-up.
 */
async function drive(
  orgFor: (i: number) => string,
  events: { at: number; name: string; run: () => Promise<void> }[],
): Promise<Timeline> {
  const results: Result[] = [];
  const samples: Sample[] = [];
  const dropped: number[] = [];
  const marks: Record<string, number> = {};
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  let sent = 0;
  let inFlight = 0;

  const fire = (i: number) => {
    const t = now();
    if (inFlight >= MAX_IN_FLIGHT) {
      dropped.push(t);
      return;
    }
    inFlight += 1;
    fetch(`${API}/messages/stats`, {
      headers: { 'x-org-id': orgFor(i) },
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (response) => {
        await response.arrayBuffer();
        results.push({
          t,
          ms: now() - t,
          status: response.status,
          source: response.headers.get('x-stats-cache') ?? '-',
          ent: response.headers.get('x-entitlement') ?? '-',
        });
      })
      .catch(() => {
        results.push({ t, ms: now() - t, status: 0, source: '-', ent: '-' });
      })
      .finally(() => {
        inFlight -= 1;
      });
  };

  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    const t = now();
    const { rows } = await sampler.query<Omit<Sample, 't'>>(SAMPLE_SQL);
    samples.push({ t, ...rows[0] });
    sampling = false;
  };

  await sample();
  const sampleTimer = setInterval(() => void sample(), BUCKET_MS);
  const fireTimer = setInterval(() => {
    const due = Math.min(Math.floor((now() / 1000) * RATE), SECONDS * RATE);
    while (sent < due) fire(sent++);
  }, 1);

  try {
    for (const event of [...events].sort((a, b) => a.at - b.at)) {
      await sleep(Math.max(0, event.at * 1000 - now()));
      await event.run();
      marks[event.name] = now();
    }
    await sleep(Math.max(0, SECONDS * 1000 - now()));
  } finally {
    clearInterval(fireTimer);
  }

  const drainUntil = now() + 15_000;
  while (inFlight > 0 && now() < drainUntil) await sleep(50);
  clearInterval(sampleTimer);
  while (sampling) await sleep(10);
  await sample();
  return { results, samples, dropped, marks };
}

/** Per bucket of `width` ms from `from` to `to`: requests by the time they were SENT, DB calls by sample time. */
function buckets(tl: Timeline, from: number, to: number, width: number) {
  const rows = [];
  for (let start = from; start < to; start += width) {
    const end = start + width;
    const sent = tl.results.filter((r) => r.t >= start && r.t < end);
    const inside = tl.samples.filter((s) => s.t >= start && s.t < end);
    const before = [...tl.samples].reverse().find((s) => s.t < start);
    const last = inside.at(-1);
    const count = (source: string) =>
      sent.filter((r) => r.source === source).length;
    rows.push({
      start,
      sent: sent.length,
      errors: sent.filter((r) => r.status !== 200).length,
      p50: pct(
        sent.map((r) => r.ms),
        0.5,
      ),
      p99: pct(
        sent.map((r) => r.ms),
        0.99,
      ),
      hit: count('hit'),
      miss: count('miss'),
      wait: count('wait'),
      stale: count('stale'),
      refresh: count('refresh'),
      db: before && last ? last.stats - before.stats : 0,
      failed: before && last ? last.rollbacks - before.rollbacks : 0,
      ent: before && last ? last.ent - before.ent : 0,
      active: Math.max(0, ...inside.map((s) => s.active)),
    });
  }
  return rows;
}

function latency(results: Result[]) {
  const times = results.map((r) => r.ms);
  return {
    n: results.length,
    p50: pct(times, 0.5),
    p99: pct(times, 0.99),
    max: Math.max(0, ...times),
    errors: results.filter((r) => r.status !== 200).length,
  };
}

async function requirePgss() {
  try {
    await sampler.query('SELECT 1 FROM pg_stat_statements LIMIT 1');
  } catch (error) {
    throw new Error(
      `pg_stat_statements is not loaded (${(error as Error).message}). ` +
        'PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db, then pnpm db:stats:on',
    );
  }
}

// --------------------------------------------------------------------- run

async function run() {
  const key = statsKey(ORG);
  await redis.del(key);
  const warm = await getStats(ORG);
  const pttl = await redis.pttl(key);
  console.log(
    `  pre-warm  ${warm.headers.get('x-stats-cache')}  key PTTL ${n0(pttl)}ms (must outlive the run)\n`,
  );
  const before = await metrics();

  const tl = await drive(
    () => ORG,
    [
      {
        at: EXPIRE_AT,
        name: 'expired',
        // The value stays; its freshness ends now. The same on every arm (search.service.ts).
        run: async () => {
          const raw = await redis.get(key);
          if (!raw) throw new Error(`${key} is gone before the forced expiry`);
          const envelope = JSON.parse(raw) as { freshUntil: number };
          await redis.set(
            key,
            JSON.stringify({ ...envelope, freshUntil: 0 }),
            'KEEPTTL',
          );
        },
      },
    ],
  );
  const after = await metrics();
  const expired = tl.marks.expired;

  // The window around the expiry, one line per bucket.
  const window = buckets(
    tl,
    expired - 5 * BUCKET_MS,
    expired + 25 * BUCKET_MS,
    BUCKET_MS,
  );
  console.log(
    `  around the forced expiry (t = 0), ${BUCKET_MS}ms buckets; requests by send time, DB calls by sample time`,
  );
  console.log(
    '     t_ms   sent  err    p50    p99   hit  miss  wait stale  refr   DB fail in-flight',
  );
  for (const b of window) {
    console.log(
      `  ${String(Math.round(b.start - expired)).padStart(7)} ${String(b.sent).padStart(6)} ${String(b.errors).padStart(4)} ${ms(b.p50).padStart(6)} ${ms(b.p99).padStart(6)} ${String(b.hit).padStart(5)} ${String(b.miss).padStart(5)} ${String(b.wait).padStart(5)} ${String(b.stale).padStart(5)} ${String(b.refresh).padStart(5)} ${String(b.db).padStart(4)} ${String(b.failed).padStart(4)} ${String(b.active).padStart(4)}  ${bar(b.db + b.failed)}`,
    );
  }

  const perSecond = buckets(tl, 0, SECONDS * 1000, 1000);
  console.log('\n  per second over the run');
  console.log('     s    sent  err    p50     p99   DB fail  ent');
  for (const b of perSecond) {
    console.log(
      `  ${String(b.start / 1000).padStart(4)} ${String(b.sent).padStart(6)} ${String(b.errors).padStart(4)} ${ms(b.p50).padStart(6)} ${ms(b.p99).padStart(7)} ${String(b.db).padStart(4)} ${String(b.failed).padStart(4)} ${String(b.ent).padStart(4)}`,
    );
  }

  const first = tl.samples[0];
  const last = tl.samples.at(-1)!;
  const client = tl.results.filter((r) =>
    ['miss', 'refresh', 'db', 'bypass'].includes(r.source),
  ).length;
  const recomputes =
    (after.stats_recomputes_total ?? 0) - (before.stats_recomputes_total ?? 0);
  const pgss = last.stats - first.stats;
  const failed = last.rollbacks - first.rollbacks;
  const affected = tl.results.filter(
    (r) => r.t >= expired && r.source !== 'hit',
  );
  const lastAffected = Math.max(expired, ...affected.map((r) => r.t));
  const steady = latency(tl.results.filter((r) => r.t < expired));
  const hot = latency(
    tl.results.filter((r) => r.t >= expired && r.t < expired + 2000),
  );
  const rest = latency(tl.results.filter((r) => r.t >= expired + 2000));
  const peakDb = Math.max(...window.map((b) => b.db + b.failed));
  const peakActive = Math.max(...window.map((b) => b.active));
  const sources: Record<string, number> = {};
  for (const r of tl.results) sources[r.source] = (sources[r.source] ?? 0) + 1;

  console.log(
    `\n  N, the stats aggregate's executions during the run, three ways`,
  );
  console.log(`    pg_stat_statements calls      ${pgss}`);
  console.log(`    /metrics stats_recomputes     ${recomputes}`);
  console.log(`    client miss+refresh+db        ${client}`);
  console.log(
    `  attempts that failed inside Postgres (xact_rollback)  ${failed}  → attempted ${pgss + failed}`,
  );
  console.log(
    `  miss window: requests sent ${ms(lastAffected - expired)}ms after the expiry still got no fresh value (${affected.length} requests)`,
  );
  console.log(
    `  peak: ${peakDb} attempts (finished + failed) in one ${BUCKET_MS}ms bucket, ${peakActive} duplicates in flight`,
  );
  console.log(
    '\n  latency by send time            n      p50      p99      max  errors',
  );
  for (const [label, l] of [
    ['before the expiry', steady],
    ['first 2s after', hot],
    ['the rest', rest],
  ] as const) {
    console.log(
      `    ${label.padEnd(24)} ${String(l.n).padStart(7)} ${ms(l.p50).padStart(8)} ${ms(l.p99).padStart(8)} ${ms(l.max).padStart(8)} ${String(l.errors).padStart(7)}`,
    );
  }
  console.log(
    `  sources: ${Object.entries(sources)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}  dropped=${tl.dropped.length}`,
  );

  return {
    n: { pgss, recomputes, client, failed },
    missWindowMs: lastAffected - expired,
    affected: affected.length,
    peakDb,
    peakActive,
    latency: { steady, hot, rest },
    sources,
    dropped: tl.dropped.length,
    window,
    perSecond,
  };
}

// -------------------------------------------------------------------- herd

function orgRange(spec: string): string[] {
  const [from, to] = spec.split('-').map(Number);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw new Error(`ORGS=${spec}: expected a range like 11-110`);
  }
  return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
}

async function herd() {
  const orgs = orgRange(ORGS);
  for (let i = 0; i < orgs.length; i += 10) {
    await Promise.all(orgs.slice(i, i + 10).map((org) => getStats(org)));
  }
  const before = await metrics();

  const tl = await drive(
    (i) => orgs[i % orgs.length],
    [
      {
        at: FLUSH_AT,
        name: 'flushed',
        // A Redis restart, a failover or a key-version bump: every key cold in the same instant.
        run: async () => {
          await redis.del(...orgs.map(statsKey));
        },
      },
    ],
  );
  const after = await metrics();
  const flushed = tl.marks.flushed;

  const fine = buckets(tl, 0, SECONDS * 1000, BUCKET_MS);
  const perSecond = buckets(tl, 0, SECONDS * 1000, 1000).map((b) => ({
    ...b,
    peak: Math.max(
      0,
      ...fine
        .filter((f) => f.start >= b.start && f.start < b.start + 1000)
        .map((f) => f.db),
    ),
  }));
  console.log(
    `  flushed ${orgs.length} keys at ${ms(flushed)}ms. Per second: stats recomputes, the busiest ${BUCKET_MS}ms bucket, p99`,
  );
  console.log('     s     DB  peak     p99  err  ent');
  for (const b of perSecond) {
    console.log(
      `  ${String(b.start / 1000).padStart(4)} ${String(b.db).padStart(6)} ${String(b.peak).padStart(5)} ${ms(b.p99).padStart(7)} ${String(b.errors).padStart(4)} ${String(b.ent).padStart(4)}  ${bar(b.db)}`,
    );
  }

  // When each key will next expire. In step, they stack in one bin; jittered, they spread.
  const now = Date.now();
  const remaining: number[] = [];
  for (const org of orgs) {
    const raw = await redis.get(statsKey(org));
    if (raw) {
      remaining.push(
        ((JSON.parse(raw) as { freshUntil: number }).freshUntil - now) / 1000,
      );
    }
  }
  const bins: Record<string, number> = {};
  for (const r of remaining) {
    const bin = Math.floor(r);
    bins[bin] = (bins[bin] ?? 0) + 1;
  }
  console.log(
    `\n  seconds until each key expires, at the end (${remaining.length} keys)`,
  );
  for (const bin of Object.keys(bins)
    .map(Number)
    .sort((a, b) => a - b)) {
    console.log(
      `    ${String(bin).padStart(4)}s  ${String(bins[bin]).padStart(4)}  ${bar(bins[bin])}`,
    );
  }

  const afterFlush = perSecond.filter((b) => b.start >= flushed);
  const recomputes =
    (after.stats_recomputes_total ?? 0) - (before.stats_recomputes_total ?? 0);
  const all = latency(tl.results);
  const spread = remaining.length
    ? Math.max(...remaining) - Math.min(...remaining)
    : NaN;
  console.log(
    `\n  recomputes ${recomputes} (pgss ${tl.samples.at(-1)!.stats - tl.samples[0].stats}) · busiest second ${Math.max(...afterFlush.map((b) => b.db))} · busiest ${BUCKET_MS}ms bucket ${Math.max(...afterFlush.map((b) => b.peak))} · median per second ${median(afterFlush.map((b) => b.db))}`,
  );
  console.log(
    `  expiry spread at the end ${ms(spread)}s · p99 ${ms(all.p99)}ms · errors ${all.errors} · dropped ${tl.dropped.length}`,
  );

  return {
    orgs: orgs.length,
    recomputes,
    spreadS: spread,
    remaining,
    latency: all,
    perSecond,
  };
}

// -------------------------------------------------------------------- main

const armState = await serverArms(API);
header(`stampede ${subcommand}  api ${API}`);
if (armState) {
  console.log(
    `  server arms  statsCache=${armState.statsCache} statsTtlS=${armState.statsTtlS} statsTtlJitter=${armState.statsTtlJitter} entitlementCache=${armState.entitlementCache}\n`,
  );
}

await sampler.connect();
await redis.connect();

let rows: unknown = null;
try {
  await requirePgss();
  rows = isRun ? await run() : await herd();
} finally {
  await sampler.end();
  redis.disconnect();
}

record('stampede', subcommand, { rows, arms: armState });
