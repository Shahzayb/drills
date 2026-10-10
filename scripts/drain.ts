// Drill 23: restart both API replicas under k6 load and report what the restart cost.
// `pnpm drain --arm graceful`, `pnpm drain --arm exit`, `pnpm drain --help`.
//
// Runs on the HOST because it drives Docker. k6 runs through scripts/load.ts, so the report lands in
// k6/reports/<run>/ beside drain.txt and timeline.json. See plans/2026-10-11_drill-23-graceful-shutdown.md.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const KNOBS = {
  arm: {
    def: 'graceful',
    help: 'SHUTDOWN on both replicas: exit | nest | graceful',
  },
  readiness: {
    def: 'local',
    help: 'READINESS on both replicas: local | deps',
  },
  rate: { def: '150', help: 'requests/s offered through the LB' },
  duration: { def: '75s', help: 'measured phase' },
  warmup: { def: '15s', help: 'discarded first phase' },
  'restart-at': {
    def: '10',
    help: 'seconds into the measured phase of the first SIGTERM',
  },
  gap: {
    def: '10',
    help: 'seconds between one replica back UP and the next SIGTERM',
  },
  rows: {
    def: '300000',
    help: 'CSV rows imported on the first replica before its SIGTERM',
  },
  'delay-ms': {
    def: '',
    help: 'DRAIN_DELAY_MS on the replicas; empty = the app default',
  },
  'deadline-ms': {
    def: '',
    help: 'SHUTDOWN_TIMEOUT_MS on the replicas; empty = the app default',
  },
  slow: {
    def: '',
    help: 'one slow request into the first drain: stats (a ~4.7s whale scan) | trickle (an 8s upload, no DB load)',
  },
  'api-key': {
    def: '',
    help: 'for org 1 ingest; minted with `pnpm db:storm key` when empty',
  },
  name: { def: '', help: 'labels the run; defaults to the arm' },
} as const;
type Flag = keyof typeof KNOBS;

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    ...Object.fromEntries(
      Object.keys(KNOBS).map((k) => [k, { type: 'string' as const }]),
    ),
  },
});
if (values.help) {
  console.log(
    'pnpm drain — a rolling restart of api_a and api_b under k6 load (drill 23)\n',
  );
  for (const [k, v] of Object.entries(KNOBS)) {
    console.log(
      `  --${k.padEnd(12)} ${(v.def || '(unset)').padEnd(10)} ${v.help}`,
    );
  }
  process.exit(0);
}
const given = values as Record<string, string | boolean | undefined>;
const opt = (k: Flag): string => String(given[k] ?? '') || KNOBS[k].def;

const ARM = opt('arm');
if (!['exit', 'nest', 'graceful'].includes(ARM))
  throw new Error(`--arm ${ARM}?`);
const LB = `http://localhost:${process.env.LB_PORT || 8080}`;
const STATS = `http://localhost:${process.env.LB_STATS_PORT || 8404}/stats;csv`;
const REPLICAS = { a: 'drills_api_a', b: 'drills_api_b' } as const;
type Replica = keyof typeof REPLICAS;
const DRAIN_ORG_NAME = 'drill-23-drain';

const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
/** Async, because a blocking call during the run would stall k6's piped stdout and every timer. */
const dockerAsync = (...args: string[]) =>
  new Promise<{ status: number; out: string }>((resolve) => {
    const child = spawn('docker', args);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (out += d));
    child.on('exit', (code) => resolve({ status: code ?? 1, out }));
  });
const psql = (sql: string) =>
  docker(
    'compose',
    'exec',
    '-T',
    'postgres_db',
    'sh',
    '-c',
    `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${sql}"`,
  ).trim();

// ------------------------------------------------------------------ the stack

/** Server name → HAProxy status (UP, DOWN, MAINT…), from the stats CSV. */
async function lbStatus(): Promise<Record<string, string>> {
  const text = await fetch(STATS).then((r) => r.text());
  const [header, ...rows] = text.trim().split('\n');
  const cols = header.replace(/^# /, '').split(',');
  const at = (name: string) => cols.indexOf(name);
  return Object.fromEntries(
    rows
      .map((r) => r.split(','))
      .filter((r) => r[at('pxname')] === 'api' && r[at('svname')].length === 1)
      .map((r) => [r[at('svname')], r[at('status')]]),
  );
}

async function waitUp(names: Replica[], ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const status = await lbStatus().catch(() => ({}) as Record<string, string>);
    if (names.every((n) => status[n] === 'UP')) return;
    await sleep(100);
  }
  throw new Error(`${names.join(',')} not UP after ${ms}ms`);
}

// A restart can beat the LB's fall x inter, leaving it UP throughout, so readiness from inside is the truth.
async function waitReady(server: Replica): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const r = await dockerAsync(
      'exec',
      REPLICAS[server],
      'wget',
      '-qO-',
      'http://localhost:3002/health',
    );
    if (r.status === 0) return;
    await sleep(100);
  }
  throw new Error(`${server} never answered /health`);
}

const env: Record<string, string> = {
  ...process.env,
  SHUTDOWN: ARM,
  READINESS: opt('readiness'),
  EVENT_LOOP_LOG_MS: '250',
} as Record<string, string>;
if (opt('delay-ms')) env.DRAIN_DELAY_MS = opt('delay-ms');
if (opt('deadline-ms')) env.SHUTDOWN_TIMEOUT_MS = opt('deadline-ms');

console.log(`drain: arm=${ARM} — starting api_a, api_b, lb`);
const up = spawnSync(
  'docker',
  [
    'compose',
    '--profile',
    'drain',
    'up',
    '-d',
    '--no-deps',
    'api_a',
    'api_b',
    'lb',
  ],
  {
    env,
    stdio: 'inherit',
  },
);
if (up.status !== 0) process.exit(1);
await Promise.all([waitReady('a'), waitReady('b')]);
await waitUp(['a', 'b']);

const arms: Record<string, Record<string, string>> = {};
for (let i = 0; i < 6 && Object.keys(arms).length < 2; i++) {
  const r = await fetch(`${LB}/info`);
  arms[r.headers.get('x-served-by') ?? '?'] = (
    (await r.json()) as { arms: Record<string, string> }
  ).arms;
}
for (const [server, a] of Object.entries(arms)) {
  if (a.shutdown !== ARM || a.readiness !== opt('readiness'))
    throw new Error(
      `replica ${server} serves shutdown=${a.shutdown} readiness=${a.readiness}, wanted ${ARM} ${opt('readiness')}`,
    );
}
const served = arms.a ?? arms.b;
console.log(
  `drain: replicas serve shutdown=${served.shutdown} readiness=${served.readiness} delay=${served.drainDelayMs}ms deadline=${served.shutdownTimeoutMs}ms`,
);

let apiKey = opt('api-key');
if (!apiKey) {
  const minted = spawnSync('pnpm', ['-s', 'db:storm', 'key', '--org', '1'], {
    encoding: 'utf8',
  }).stdout;
  apiKey = minted.match(/dk_[a-f0-9]+/)?.[0] ?? '';
  if (!apiKey) throw new Error('could not mint an api key');
}

let orgId = psql(
  `SELECT id FROM organizations WHERE name = '${DRAIN_ORG_NAME}'`,
);
if (!orgId)
  orgId = psql(
    `INSERT INTO organizations (name, plan) VALUES ('${DRAIN_ORG_NAME}', 'pro') RETURNING id`,
  ).split('\n')[0];

// ------------------------------------------------------------------- the run

const startedAt = new Date();
const name = opt('name') || ARM;
// Streamed live: the daemon keeps a short ring of past events, and health-check execs overflow it in ~90s.
const watcher = spawn('docker', [
  'events',
  '--format',
  '{{json .}}',
  '--filter',
  `container=${REPLICAS.a}`,
  '--filter',
  `container=${REPLICAS.b}`,
]);
let eventLines = '';
watcher.stdout.on('data', (d: Buffer) => (eventLines += d));
const k6 = spawn(
  'node',
  [
    'scripts/load.ts',
    'drain',
    '--base-url',
    'http://lb:8080',
    '--org',
    '2-10',
    '--rate',
    opt('rate'),
    '--duration',
    opt('duration'),
    '--warmup',
    opt('warmup'),
    '--name',
    name,
    '--api-key',
    apiKey,
  ],
  {
    cwd: root,
    env: { ...process.env, INFO_URL: `${LB}/info` },
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
let k6Out = '';
k6.stdout.on('data', (d: Buffer) => {
  k6Out += d;
  process.stdout.write(d);
});
const k6Done = new Promise<number>((resolve) =>
  k6.on('exit', (code) => resolve(code ?? 1)),
);

const secs = (d: string) => Number(d.replace(/s$/, ''));
// docker compose run takes ~1-2s to start k6; the restart is timed from spawn, which is close enough.
const firstKill = (secs(opt('warmup')) + Number(opt('restart-at'))) * 1000;

const ROWS = Number(opt('rows'));
const stamp = startedAt.toISOString().replace(/\D/g, '').slice(0, 14);
async function* csv(): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  let chunk = 'external_id,status,created_at,updated_at,subject,message\n';
  for (let i = 1; i <= ROWS; i++) {
    chunk +=
      `drain-${stamp}-${i},${i % 2 ? 'open' : 'closed'},2024-03-04T09:30:00Z,2024-03-05T14:15:00Z,` +
      `"Ticket ${i}",imported during a rolling restart ${i}\n`;
    if (chunk.length > 256 * 1024) {
      yield enc.encode(chunk);
      chunk = '';
    }
  }
  yield enc.encode(chunk);
}

await sleep(Math.max(0, firstKill - 6000));
const upload = await fetch(`${LB}/imports`, {
  method: 'POST',
  headers: {
    'x-org-id': orgId,
    'content-type': 'text/csv',
    'x-filename': `drain-${stamp}.csv`,
  },
  body: csv() as unknown as BodyInit,
  duplex: 'half',
} as RequestInit);
const job = (await upload.json()) as { id: string };
const first = (upload.headers.get('x-served-by') ?? 'a') as Replica;
const second: Replica = first === 'a' ? 'b' : 'a';
console.log(
  `drain: import ${job.id} (${ROWS} rows) on ${first}; restarting ${first} then ${second}`,
);

const marks: { t: number; what: string }[] = [];
const mark = (what: string) => marks.push({ t: Date.now(), what });

// Sent from inside the replica, so it lands on the one draining. 16 rows, one every 500ms.
const trickle = (
  org: string,
) => `const r=require('http').request({port:3002,method:'POST',path:'/imports',headers:{'x-org-id':'${org}',
'content-type':'text/csv'}},(res)=>{console.log('status '+res.statusCode);res.resume()});
r.on('error',(e)=>{console.log('error '+e.code);process.exitCode=1});
r.write('external_id,status,created_at,updated_at,subject,message\\n');let i=0;const t=setInterval(()=>{
r.write('trickle-'+Date.now()+',open,2024-03-04T09:30:00Z,2024-03-04T09:30:00Z,s,m\\n');if(++i>=16){clearInterval(t);r.end()}},500);`;

async function restart(server: Replica, slow: string): Promise<void> {
  const container = REPLICAS[server];
  const send = () =>
    slow === 'trickle'
      ? dockerAsync('exec', container, 'node', '-e', trickle(orgId))
      : dockerAsync(
          'exec',
          container,
          'wget',
          '-qO-',
          '-T',
          '30',
          '--header',
          'x-org-id: 1',
          '--header',
          'cache-control: no-cache',
          'http://localhost:3002/messages/stats',
        );
  const slowReq = slow
    ? sleep(1000).then(() => {
        mark(`${server} slow request (${slow}) sent`);
        return send();
      })
    : null;
  mark(`${server} stop`);
  await dockerAsync('stop', '-t', '30', container);
  mark(`${server} exited`);
  if (slowReq) {
    const r = await slowReq;
    mark(
      `${server} slow request: exit ${r.status} ${r.out.trim().split('\n').pop()?.slice(0, 80) ?? ''}`,
    );
  }
  await dockerAsync('start', container);
  mark(`${server} start`);
  await waitReady(server);
  mark(`${server} ready`);
  await waitUp([server]);
  mark(`${server} UP`);
}

await sleep(Math.max(0, firstKill - (Date.now() - startedAt.getTime())));
await restart(first, opt('slow'));
await sleep(Number(opt('gap')) * 1000);
await restart(second, '');

const k6Code = await k6Done;
const reportDir = `${root}${k6Out.match(/k6\/reports\/[^/\s]+\//)?.[0] ?? ''}`;

// --------------------------------------------------------------- the import

type Job = {
  status: string;
  error: string | null;
  resumeRow: number;
  rowsWritten: number;
  rowsSkipped: number;
  startedAt: string | null;
  updatedAt: string;
};
const readJob = async () =>
  (await (
    await fetch(`${LB}/imports/${job.id}`, { headers: { 'x-org-id': orgId } })
  ).json()) as Job;
let after = await readJob();
for (
  let i = 0;
  i < 600 &&
  after.status === 'running' &&
  Date.now() - Date.parse(after.updatedAt) < 15_000;
  i++
) {
  await sleep(500);
  after = await readJob();
}
const importLines = [
  `  after the restart : ${after.status}${after.error ? ` (${after.error})` : ''}, resume_row ${after.resumeRow}, ` +
    `updated ${Math.round((Date.now() - Date.parse(after.updatedAt)) / 1000)}s ago`,
];
if (after.status === 'failed') {
  await fetch(`${LB}/imports/${job.id}/retry`, {
    method: 'POST',
    headers: { 'x-org-id': orgId },
  });
  let retried = await readJob();
  // The retry answers 202 before the worker marks the job running, so wait for a fresh start first.
  for (
    let i = 0;
    i < 1200 &&
    (retried.startedAt === after.startedAt ||
      !['succeeded', 'failed'].includes(retried.status));
    i++
  ) {
    await sleep(500);
    retried = await readJob();
  }
  importLines.push(
    `  after one retry   : ${retried.status}, written ${retried.rowsWritten} + skipped ${retried.rowsSkipped} ` +
      `= ${retried.rowsWritten + retried.rowsSkipped} of ${ROWS}`,
  );
} else if (after.status === 'running') {
  importLines.push(
    '  stuck             : `running` with no worker; POST /imports/:id/retry refuses a running job',
  );
}

// ----------------------------------------------------------- the timeline

const since = startedAt.toISOString();
const until = new Date().toISOString();
type Event = { t: number; src: string; what: string };
const events: Event[] = [];

watcher.kill();
for (const line of eventLines.trim().split('\n').filter(Boolean)) {
  const e = JSON.parse(line) as {
    timeNano: number;
    Action: string;
    Actor: { Attributes: Record<string, string> };
  };
  if (!['kill', 'die', 'start'].includes(e.Action)) continue;
  const server = e.Actor.Attributes.name.slice(-1);
  const extra =
    e.Action === 'kill'
      ? ` signal ${e.Actor.Attributes.signal}`
      : e.Action === 'die'
        ? ` exit ${e.Actor.Attributes.exitCode}`
        : '';
  events.push({
    t: Math.round(e.timeNano / 1e6),
    src: server,
    what: `docker ${e.Action}${extra}`,
  });
}

type Lag = {
  t: number;
  server: string;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  phase: string;
  inFlight: number;
};
const lag: Lag[] = [];
for (const server of ['a', 'b'] as Replica[]) {
  for (const line of docker(
    'logs',
    '--since',
    since,
    '--until',
    until,
    REPLICAS[server],
  ).split('\n')) {
    if (!line.startsWith('{')) continue;
    const j = JSON.parse(line) as Record<string, unknown> & {
      time: string;
      msg: string;
    };
    const t = Date.parse(j.time);
    if (j.msg === 'event_loop')
      lag.push({ ...(j as unknown as Lag), t, server });
    else if (/^(shutdown_|drain_|import_drain|import_failed)/.test(j.msg)) {
      const detail = ['inFlight', 'jobs', 'ms', 'err']
        .filter((k) => k in j)
        .map((k) => `${k}=${String(j[k])}`)
        .join(' ');
      events.push({ t, src: server, what: `${j.msg} ${detail}`.trim() });
    }
  }
}

const lbLog = spawnSync(
  'docker',
  ['logs', '-t', '--since', since, '--until', until, 'drills_lb'],
  { encoding: 'utf8' },
);
const lbErrors: string[] = [];
for (const line of `${lbLog.stdout}${lbLog.stderr}`.split('\n')) {
  const [ts, ...rest] = line.split(' ');
  const text = rest.join(' ');
  const state = text.match(/Server api\/(\w) is (UP|DOWN)/);
  if (state && !text.startsWith('['))
    events.push({ t: Date.parse(ts), src: state[1], what: `lb ${state[2]}` });
  else if (/ \d{3} \d+ /.test(text) && !text.startsWith('['))
    lbErrors.push(text);
}
events.push(...marks.map((m) => ({ t: m.t, src: 'host', what: m.what })));
events.sort((x, y) => x.t - y.t);

type Failure = {
  t: number;
  ep: string;
  status: number;
  code: number;
  by: string | null;
  scenario: string;
};
const failures: Failure[] = existsSync(`${reportDir}failures.ndjson`)
  ? readFileSync(`${reportDir}failures.ndjson`, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Failure)
  : [];

const t0 =
  events.find((e) => e.what.startsWith('docker kill'))?.t ??
  startedAt.getTime();
const rel = (t: number) => ((t - t0) / 1000).toFixed(3).padStart(8);
const tally = (key: (f: Failure) => string) =>
  Object.entries(
    failures.reduce<Record<string, number>>(
      (acc, f) => ({ ...acc, [key(f)]: (acc[key(f)] ?? 0) + 1 }),
      {},
    ),
  )
    .map(([k, v]) => `${k} ×${v}`)
    .join(' · ') || 'none';

const perSecond = new Map<number, number>();
for (const f of failures)
  perSecond.set(
    Math.floor((f.t - t0) / 1000),
    (perSecond.get(Math.floor((f.t - t0) / 1000)) ?? 0) + 1,
  );

const firstKillEvent = events.find(
  (e) => e.src === first && e.what.startsWith('docker kill'),
);
const firstDie = events.find(
  (e) => e.src === first && e.what.startsWith('docker die'),
);
const window = lag.filter(
  (l) =>
    l.server === first &&
    firstKillEvent &&
    l.t >= firstKillEvent.t - 5000 &&
    l.t <= (firstDie?.t ?? Infinity) + 250,
);
const xs = window.map((l) =>
  ((l.t - (firstKillEvent?.t ?? 0)) / 1000).toFixed(2),
);

const summaryTxt = existsSync(`${reportDir}summary.txt`)
  ? readFileSync(`${reportDir}summary.txt`, 'utf8')
  : '';
const report = [
  `drain — arm=${ARM} readiness=${served.readiness} rate=${opt('rate')}/s delay=${served.drainDelayMs}ms deadline=${served.shutdownTimeoutMs}ms ` +
    `rows=${ROWS} k6 exit ${k6Code}`,
  '',
  `  failed requests   : ${failures.length} (${failures.filter((f) => f.scenario === 'measure').length} in the measured phase)`,
  // A run that fails before any SIGTERM was not at steady state, so it measures something else.
  `  before SIGTERM    : ${failures.filter((f) => f.t < t0).length} (must be 0 for the run to count)`,
  `  LB had no server : ${failures.filter((f) => f.status === 503 && !f.by).length} × 503`,
  `  by status         : ${tally((f) => String(f.status))}`,
  `  by k6 error code  : ${tally((f) => String(f.code))}`,
  `  by endpoint       : ${tally((f) => f.ep)}`,
  `  by replica        : ${tally((f) => f.by ?? 'lb (no server)')}`,
  `  per second (t=0 is the first SIGTERM): ${
    [...perSecond]
      .sort((x, y) => x[0] - y[0])
      .map(([s, n]) => `${s}s:${n}`)
      .join(' ') || 'none'
  }`,
  '',
  `  import ${job.id} on ${first}`,
  ...importLines,
  '',
  '  timeline (seconds from the first SIGTERM)',
  ...events.map((e) => `  ${rel(e.t)}  ${e.src.padEnd(4)} ${e.what}`),
  '',
  `  haproxy abnormal sessions: ${lbErrors.length}`,
  ...lbErrors.slice(0, 15).map((l) => `    ${l}`),
  '',
  `  event-loop lag on ${first}, 250ms windows from 5s before its SIGTERM to its exit`,
  '```mermaid',
  'xychart-beta',
  `  title "Event-loop lag on api_${first} around SIGTERM (arm ${ARM})"`,
  `  x-axis "seconds from SIGTERM" [${xs.map((x) => `"${x}"`).join(', ')}]`,
  `  y-axis "lag (ms)"`,
  `  line [${window.map((l) => l.p50Ms).join(', ')}]`,
  `  line [${window.map((l) => l.maxMs).join(', ')}]`,
  '```',
  '  (first line p50, second line max; a 250ms window holds ~23 samples, so its p99 is its max)',
  ...window.map(
    (l) =>
      `  ${rel(l.t)}  p50 ${l.p50Ms} p99 ${l.p99Ms} max ${l.maxMs} phase ${l.phase} inFlight ${l.inFlight}`,
  ),
  '',
  summaryTxt,
].join('\n');

console.log(`\n${report}`);
if (reportDir.endsWith('/')) {
  writeFileSync(`${reportDir}drain.txt`, `${report}\n`);
  writeFileSync(
    `${reportDir}timeline.json`,
    `${JSON.stringify({ arm: ARM, arms, events, lag, failures, import: after }, null, 1)}\n`,
  );
  console.log(`\nwritten to ${reportDir.slice(root.length)}drain.txt`);
}
