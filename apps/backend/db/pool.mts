// Drill 22's instrument: the server side of one pool-size run, read beside `pnpm load pool`.
// Runs in the container: `pnpm db:pool watch`. See plans/2026-10-06_drill-22-connection-pool-knee.md.
//
//   watch  wait DELAY s (k6's warm-up), then read Postgres and the API for SECONDS s
//
// Connects as the owner: pg_read_file on /proc and /sys needs a superuser. The pool size is the
// server's (`PG_POOL_MAX=<n> docker compose up -d nest_server`); this reads it from /info.

import { readFileSync } from 'node:fs';
import {
  client as pgClient,
  header,
  knobNumber,
  record,
  serverArms,
} from './lib/run.mts';

const subcommand = process.argv[2];
const SUBCOMMANDS = ['watch'];

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(`usage: node db/pool.mts <${SUBCOMMANDS.join('|')}>`);
  process.exit(1);
}

const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const APP_USER = process.env.POSTGRES_APP_USER;
const DELAY = knobNumber('DELAY', 20);
const SECONDS = knobNumber('SECONDS', 60);
const SAMPLE_MS = knobNumber('SAMPLE_MS', 1000);

if (!APP_USER) throw new Error('POSTGRES_APP_USER is required');

const client = pgClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const n1 = (x: number) => x.toFixed(1);
const n2 = (x: number) => x.toFixed(2);

/** `usage_usec` from a cgroup v2 cpu.stat: CPU time used by every process in the container. */
const cpuUsec = (stat: string) => Number(/usage_usec (\d+)/.exec(stat)?.[1]);

/** The parts of a `/metrics` page this reads: histogram buckets, sums and counts, error counters. */
const metrics = async (): Promise<Map<string, number>> => {
  const text = await (await fetch(`${API}/metrics`)).text();
  return new Map(
    text
      .split('\n')
      .filter((line) => line.startsWith('pg_pool_'))
      .map((line) => {
        const at = line.lastIndexOf(' ');
        return [line.slice(0, at), Number(line.slice(at + 1))];
      }),
  );
};

interface Snapshot {
  at: number;
  pgUsec: number;
  apiUsec: number;
  ctxt: number;
  commits: number;
  backends: Map<number, { voluntary: number; involuntary: number }>;
  metrics: Map<string, number>;
}

async function snapshot(): Promise<Snapshot> {
  const { rows } = await client.query<{
    cpu: string;
    stat: string;
    commits: string;
  }>(
    `SELECT pg_read_file('/sys/fs/cgroup/cpu.stat') AS cpu,
            pg_read_file('/proc/stat') AS stat,
            (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()) AS commits`,
  );
  // missing_ok: a backend can exit between the list and the read.
  const procs = await client.query<{ pid: number; status: string | null }>(
    `SELECT pid, pg_read_file('/proc/' || pid || '/status', true) AS status
       FROM pg_stat_activity
      WHERE usename = $1 AND backend_type = 'client backend'`,
    [APP_USER],
  );
  const switches = (status: string, kind: string) =>
    Number(
      new RegExp(`^${kind}_ctxt_switches:\\s+(\\d+)`, 'm').exec(status)?.[1],
    );

  return {
    at: performance.now(),
    pgUsec: cpuUsec(rows[0].cpu),
    apiUsec: cpuUsec(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8')),
    ctxt: Number(/^ctxt (\d+)/m.exec(rows[0].stat)?.[1]),
    commits: Number(rows[0].commits),
    backends: new Map(
      procs.rows
        .filter((row) => row.status)
        .map((row) => [
          row.pid,
          {
            voluntary: switches(row.status!, 'voluntary'),
            involuntary: switches(row.status!, 'nonvoluntary'),
          },
        ]),
    ),
    metrics: await metrics(),
  };
}

interface Sample {
  active: number;
  idleInTx: number;
  connected: number;
  runnable: number;
  waits: Record<string, number>;
}

/** One second of pg_stat_activity for the app role, plus the VM's runnable task count. */
async function sample(): Promise<Sample> {
  const { rows } = await client.query<{
    state: string | null;
    wait: string;
    n: number;
  }>(
    `SELECT state, coalesce(wait_event_type || ':' || wait_event, 'CPU') AS wait, count(*)::int AS n
       FROM pg_stat_activity
      WHERE usename = $1 AND backend_type = 'client backend'
      GROUP BY 1, 2`,
    [APP_USER],
  );
  const s: Sample = {
    active: 0,
    idleInTx: 0,
    connected: 0,
    runnable: 0,
    waits: {},
  };
  for (const row of rows) {
    s.connected += row.n;
    if (row.state === 'idle in transaction') s.idleInTx += row.n;
    if (row.state !== 'active') continue;
    s.active += row.n;
    s.waits[row.wait] = (s.waits[row.wait] ?? 0) + row.n;
  }
  // The 4th field of /proc/loadavg is running/total; running includes this query's own backend.
  const load = await client.query<{ l: string }>(
    `SELECT pg_read_file('/proc/loadavg') AS l`,
  );
  s.runnable = Number(load.rows[0].l.split(' ')[3].split('/')[0]);
  return s;
}

const BUCKETS = [
  '0.0005',
  '0.001',
  '0.0025',
  '0.005',
  '0.01',
  '0.025',
  '0.05',
  '0.1',
  '0.25',
  '0.5',
  '1',
  '2.5',
];

/** The window's histogram, from two cumulative snapshots: count, mean and bucket-bounded quantiles. */
function histogramDelta(name: string, a: Snapshot, b: Snapshot) {
  const d = (series: string) =>
    (b.metrics.get(series) ?? 0) - (a.metrics.get(series) ?? 0);
  const count = d(`${name}_count`);
  const sum = d(`${name}_sum`);
  // The upper bound of the first bucket holding the q-th observation. Bucket-coarse by design.
  const quantile = (q: number) => {
    const le = BUCKETS.find(
      (le) => d(`${name}_bucket{le="${le}"}`) >= q * count,
    );
    return le ? `≤${Number(le) * 1000}ms` : '>2500ms';
  };
  return {
    count,
    meanMs: count ? (sum / count) * 1000 : 0,
    p50: quantile(0.5),
    p99: quantile(0.99),
  };
}

await client.connect();
await client.query(`SET application_name = 'db:pool'`);
const arms = await serverArms(API);

header(`pool ${subcommand}  api ${API}  poolMax ${arms?.poolMax ?? '?'}`);

const limits = await client.query<{ name: string; setting: string }>(
  `SELECT name, setting FROM pg_settings
    WHERE name IN ('max_connections', 'superuser_reserved_connections', 'reserved_connections',
                   'max_worker_processes', 'max_parallel_workers', 'max_parallel_workers_per_gather')
    ORDER BY name`,
);
console.log(
  limits.rows.map((r) => `  ${r.name.padEnd(32)} ${r.setting}`).join('\n'),
);

await sleep(DELAY * 1000);

const connections = await client.query<{
  usename: string;
  app: string;
  n: number;
}>(
  `SELECT usename, application_name AS app, count(*)::int AS n FROM pg_stat_activity
    WHERE backend_type = 'client backend' GROUP BY 1, 2 ORDER BY 3 DESC`,
);
console.log(
  `\n  connections at window start: ${connections.rows
    .map((r) => `${r.usename}${r.app ? `/${r.app}` : ''} ${r.n}`)
    .join(' · ')}\n`,
);

const start = await snapshot();
const samples: Sample[] = [];
const stopAt = start.at + SECONDS * 1000;
while (performance.now() < stopAt) {
  const tick = performance.now();
  samples.push(await sample());
  await sleep(Math.max(0, SAMPLE_MS - (performance.now() - tick)));
}
const end = await snapshot();

const seconds = (end.at - start.at) / 1000;
const mean = (pick: (s: Sample) => number) =>
  samples.reduce((sum, s) => sum + pick(s), 0) / samples.length;
const max = (pick: (s: Sample) => number) => Math.max(...samples.map(pick));

// Only backends alive at both ends: a connection opened mid-window has no baseline.
let voluntary = 0;
let involuntary = 0;
let survivors = 0;
for (const [pid, b] of end.backends) {
  const a = start.backends.get(pid);
  if (!a) continue;
  survivors += 1;
  voluntary += b.voluntary - a.voluntary;
  involuntary += b.involuntary - a.involuntary;
}

const waitTotals: Record<string, number> = {};
for (const s of samples) {
  for (const [wait, n] of Object.entries(s.waits)) {
    waitTotals[wait] = (waitTotals[wait] ?? 0) + n;
  }
}
const activeTotal = Object.values(waitTotals).reduce((a, b) => a + b, 0);
const topWaits = Object.entries(waitTotals)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6)
  .map(([wait, n]) => `${wait} ${((n / activeTotal) * 100).toFixed(0)}%`);

const wait = histogramDelta('pg_pool_acquire_wait_seconds', start, end);
const hold = histogramDelta('pg_pool_hold_seconds', start, end);
const errors = (reason: string) => {
  const series = `pg_pool_acquire_errors_total{reason="${reason}"}`;
  return (end.metrics.get(series) ?? 0) - (start.metrics.get(series) ?? 0);
};

const result = {
  poolMax: arms?.poolMax ?? null,
  seconds,
  pgCores: (end.pgUsec - start.pgUsec) / 1e6 / seconds,
  apiCores: (end.apiUsec - start.apiUsec) / 1e6 / seconds,
  vmCtxtPerS: (end.ctxt - start.ctxt) / seconds,
  backendsTracked: survivors,
  backendInvoluntaryPerS: involuntary / seconds,
  backendVoluntaryPerS: voluntary / seconds,
  commitsPerS: (end.commits - start.commits) / seconds,
  activeMean: mean((s) => s.active),
  activeMax: max((s) => s.active),
  idleInTxMean: mean((s) => s.idleInTx),
  connectedMean: mean((s) => s.connected),
  runnableMean: mean((s) => s.runnable),
  waits: Object.fromEntries(
    Object.entries(waitTotals).map(([w, n]) => [w, n / activeTotal]),
  ),
  acquire: {
    ...wait,
    timeouts: errors('timeout'),
    connectErrors: errors('connect'),
  },
  hold,
};

console.log(
  [
    `  window            : ${n1(seconds)}s, ${samples.length} samples`,
    `  postgres cpu      : ${n2(result.pgCores)} cores`,
    `  api cpu           : ${n2(result.apiCores)} cores`,
    `  runnable tasks    : ${n1(result.runnableMean)} mean (VM-wide, /proc/loadavg)`,
    `  app backends      : ${n1(result.connectedMean)} connected · ${n1(result.activeMean)} active (max ${result.activeMax}) · ${n1(result.idleInTxMean)} idle in transaction`,
    `  active waits      : ${topWaits.join(' · ') || '(none)'}`,
    `  ctx switches      : ${n0(result.vmCtxtPerS)}/s VM · backends ${n0(result.backendInvoluntaryPerS)}/s involuntary, ${n0(result.backendVoluntaryPerS)}/s voluntary (${survivors} tracked)`,
    `  commits           : ${n0(result.commitsPerS)}/s`,
    `  acquire wait      : ${n0(wait.count)} acquires, mean ${n2(wait.meanMs)}ms, p50 ${wait.p50}, p99 ${wait.p99}; ${result.acquire.timeouts} timeouts, ${result.acquire.connectErrors} connect errors`,
    `  connection hold   : mean ${n2(hold.meanMs)}ms, p50 ${hold.p50}, p99 ${hold.p99}`,
  ].join('\n'),
);

await client.end();
record('pool', subcommand, { rows: result, arms });
