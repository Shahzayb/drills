// Drill 24: N replicas of the API behind nginx, and the chaos that tests the run-once job.
// `pnpm replicas up --scheduler all`, `pnpm replicas chaos --do pause --hold 15`, `pnpm replicas --help`.
//
// Runs on the HOST because it drives Docker. Every docker command is printed before it runs, so each
// step can be repeated by hand. See plans/2026-10-12_drill-24-three-replicas.md.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const SUBCOMMANDS = {
  up: 'start (or recreate) the replicas and nginx with the given arms, then wait until each is live',
  spread: 'send N requests through nginx and count which replica answered each',
  holder: 'print which replica holds the job lease',
  chaos:
    'wait until the lease holder is mid-job, then kill or pause it; report the failover',
  blip: 'run k6 through nginx, kill or stop one replica mid-load, report the errors and when nginx noticed',
  down: 'remove the replicas and nginx',
} as const;

/** Flag → the compose variable it sets on `up`. Unset flags leave the shell's value alone. */
const ARMS = {
  scheduler: 'SCHEDULER',
  'rate-limit': 'RATE_LIMIT',
  pool: 'PG_POOL_MAX',
  'slot-s': 'JOB_SLOT_S',
  'work-ms': 'JOB_WORK_MS',
  'lease-ms': 'LEASE_TTL_MS',
  'keep-alive-ms': 'KEEP_ALIVE_TIMEOUT_MS',
} as const;

const KNOBS = {
  scale: { def: '3', help: 'up: how many replicas' },
  n: { def: '300', help: 'spread: requests' },
  do: {
    def: 'kill',
    help: 'chaos: kill | pause. blip: kill (SIGKILL) | stop (SIGTERM, then SIGKILL after the grace period)',
  },
  hold: { def: '15', help: 'chaos: seconds a pause lasts' },
  target: { def: 'drills-api-2', help: 'blip: the replica to kill or stop' },
  at: { def: '30', help: 'blip: seconds after k6 starts (warm-up included)' },
  rate: { def: '150', help: 'blip: requests/s offered' },
  duration: { def: '60s', help: 'blip: measured phase (after a 10s warm-up)' },
  'api-key': {
    def: '',
    help: 'blip: org 1 key for the ingest share; minted (and its report deleted) when empty',
  },
} as const;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    ...Object.fromEntries(
      [...Object.keys(ARMS), ...Object.keys(KNOBS)].map((k) => [
        k,
        { type: 'string' as const },
      ]),
    ),
  },
});
const sub = positionals[0] as keyof typeof SUBCOMMANDS | undefined;
if (values.help || !sub || !(sub in SUBCOMMANDS)) {
  console.log('pnpm replicas <subcommand> — drill 24\n');
  for (const [k, v] of Object.entries(SUBCOMMANDS))
    console.log(`  ${k.padEnd(8)} ${v}`);
  console.log('\n  arms (up):');
  for (const [k, v] of Object.entries(ARMS))
    console.log(`    --${k.padEnd(10)} ${v}`);
  console.log('\n  knobs:');
  for (const [k, v] of Object.entries(KNOBS))
    console.log(`    --${k.padEnd(10)} ${v.def.padEnd(6)} ${v.help}`);
  process.exit(values.help ? 0 : 1);
}
const given = values as Record<string, string | undefined>;
const opt = (k: keyof typeof KNOBS) => given[k] || KNOBS[k].def;

const NGINX = `http://localhost:${process.env.NGINX_PORT || 8088}`;
const LEASE_KEY = 'lease:v1:job:usage-rollup';

const docker = (args: string[], env = process.env, quiet = false) => {
  if (!quiet) console.log(`$ docker ${args.join(' ')}`);
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const sh = (container: string, cmd: string, quiet = true) =>
  docker(['exec', container, 'sh', '-c', cmd], process.env, quiet);
const psql = (sql: string) =>
  sh(
    'drills_postgres',
    `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${sql}"`,
  );
const redisGet = (key: string) =>
  sh(
    'drills_redis',
    `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning GET ${key}`,
  );

interface Replica {
  name: string;
  id: string;
  ip: string;
}

function replicas(): Replica[] {
  const ids = docker(
    ['compose', '--profile', 'replicas', 'ps', '-q', 'api'],
    process.env,
    true,
  )
    .split('\n')
    .filter(Boolean);
  return ids
    .map((id) => {
      const [name, ip] = docker(
        [
          'inspect',
          '-f',
          '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
          id,
        ],
        process.env,
        true,
      ).split(' ');
      return { name: name.replace(/^\//, ''), id: id.slice(0, 12), ip };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const byHost = (holder: string) =>
  replicas().find((r) => holder.startsWith(`${r.id}:`))?.name ??
  `${holder.split(':')[0]} (not a replica)`;

async function until<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  ms: number,
  every = 200,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// ---------------------------------------------------------------- subcommands

async function up(): Promise<void> {
  const env = { ...process.env };
  for (const [flag, name] of Object.entries(ARMS)) {
    if (given[flag] !== undefined) env[name] = given[flag];
  }
  docker(
    [
      'compose',
      '--profile',
      'replicas',
      'up',
      '-d',
      '--no-deps',
      '--force-recreate',
      '--scale',
      `api=${opt('scale')}`,
      'api',
      'nginx',
    ],
    env,
  );

  const live = replicas();
  for (const r of live) {
    await until(
      `${r.name} /health/live`,
      () => {
        try {
          sh(r.name, 'wget -qO- localhost:3002/health/live');
          return true;
        } catch {
          return undefined;
        }
      },
      60_000,
      500,
    );
  }
  await until(
    'nginx',
    async () =>
      (await fetch(`${NGINX}/health`).catch(() => null))?.ok || undefined,
    30_000,
  );

  console.log('\n  replica            id            ip            arms');
  for (const r of live) {
    const { arms } = JSON.parse(
      sh(r.name, 'wget -qO- localhost:3002/info'),
    ) as {
      arms: Record<string, string>;
    };
    console.log(
      `  ${r.name.padEnd(18)} ${r.id}  ${r.ip.padEnd(12)}  scheduler=${arms.scheduler} rateLimit=${arms.rateLimit} pool=${arms.poolMax} slot=${arms.jobSlotS}s lease=${arms.leaseTtlMs}ms keepAlive=${arms.keepAliveTimeoutMs}ms`,
    );
  }
  console.log(`\n  nginx on ${NGINX}`);
}

async function spread(): Promise<void> {
  const names = new Map(replicas().map((r) => [`${r.ip}:3002`, r.name]));
  const tally: Record<string, number> = {};
  for (let i = 0; i < Number(opt('n')); i++) {
    const response = await fetch(`${NGINX}/health`);
    await response.arrayBuffer();
    const by = response.headers.get('x-served-by') ?? '?';
    const name = names.get(by) ?? by;
    tally[name] = (tally[name] ?? 0) + 1;
  }
  for (const [name, n] of Object.entries(tally).sort())
    console.log(`  ${name.padEnd(18)} ${n}`);
}

function holder(): string | undefined {
  const value = redisGet(LEASE_KEY);
  return value || undefined;
}

async function chaos(): Promise<void> {
  const action = opt('do');
  if (action !== 'kill' && action !== 'pause')
    throw new Error(`--do ${action}?`);

  const before = await until('a lease holder', holder, 30_000);
  const target = byHost(before);
  console.log(`  holder ${before} → ${target}`);

  // Mid-job: its job transaction is open (JOB_WORK_MS keeps it open long enough to land in).
  const midJob = await until(
    'the holder to start a job',
    () =>
      psql(
        `SELECT 1 FROM pg_stat_activity WHERE application_name = 'job:${before}'`,
      ) || undefined,
    120_000,
    100,
  );
  void midJob;

  const t0 = Date.now();
  if (action === 'kill') docker(['kill', target]);
  else docker(['pause', target]);

  const after = await until(
    'a new lease holder',
    () => {
      const h = holder();
      return h && h !== before ? h : undefined;
    },
    120_000,
    100,
  );
  const failoverMs = Date.now() - t0;
  console.log(
    `  new holder ${after} → ${byHost(after)} after ${(failoverMs / 1000).toFixed(2)}s`,
  );

  if (action === 'pause') {
    const left = Number(opt('hold')) * 1000 - (Date.now() - t0);
    if (left > 0) await sleep(left);
    docker(['unpause', target]);
  }

  // Long enough for the old holder to resume or restart and for the next slot to run.
  await sleep(15_000);
  const since = new Date(t0 - 20_000).toISOString();
  const log = docker(
    [
      'compose',
      '--profile',
      'replicas',
      'logs',
      '--no-color',
      '--since',
      since,
      'api',
    ],
    process.env,
    true,
  );
  console.log(`\n  timeline (t0 = ${action} at ${new Date(t0).toISOString()})`);
  const events =
    /leader_|job_ran|job_slot_taken|job_claim_blocked|job_failed|pool_client_error|scheduler_started/;
  for (const line of log.split('\n')) {
    const json = line.slice(line.indexOf('{'));
    if (!events.test(json)) continue;
    try {
      const e = JSON.parse(json) as Record<string, string | number>;
      if (e.slot && String(e.slot).startsWith('2001')) continue;
      const at = ((Date.parse(String(e.time)) - t0) / 1000).toFixed(2);
      const who = line.slice(0, line.indexOf('|')).trim();
      console.log(
        `  ${at.padStart(7)}s  ${who.padEnd(16)} ${String(e.msg).padEnd(18)} ${e.slot ? `slot ${String(e.slot).slice(11, 19)} ` : ''}term ${e.term ?? '-'}${e.err ? `  ${e.err}` : ''}`,
      );
    } catch {
      // A line that is not one of ours.
    }
  }
}

/** A key for org 1. `db:storm key` writes the plaintext into a report directory, which is deleted here. */
function mintKey(): string {
  const reports = `${root}apps/backend/db/reports`;
  const before = new Set(readdirSync(reports));
  const out = spawnSync('pnpm', ['-s', 'db:storm', 'key', '--org', '1'], {
    encoding: 'utf8',
  }).stdout;
  for (const dir of readdirSync(reports)) {
    if (!before.has(dir) && dir.includes('storm-key'))
      rmSync(`${reports}/${dir}`, { recursive: true });
  }
  const key = /dk_[a-f0-9]+/.exec(out)?.[0];
  if (!key) throw new Error('could not mint an api key');
  return key;
}

interface Failure {
  t: number;
  ep: string;
  status: number;
}

async function blip(): Promise<void> {
  const action = opt('do');
  if (action !== 'kill' && action !== 'stop')
    throw new Error(`--do ${action}?`);
  const target = opt('target');
  const ip = replicas().find((r) => r.name === target)?.ip;
  if (!ip) throw new Error(`${target} is not running`);
  const key = opt('api-key') || mintKey();

  const startedAt = new Date();
  const load = spawn(
    'node',
    [
      'scripts/load.ts',
      'drain',
      '--base-url',
      'http://nginx:8080',
      '--rate',
      opt('rate'),
      '--warmup',
      '10s',
      '--duration',
      opt('duration'),
      '--org',
      '2-10',
      '--api-key',
      key,
      '--name',
      `blip-${action}`,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  load.stdout.on('data', (d: Buffer) => (out += d.toString()));
  const finished = new Promise((resolve) => load.on('exit', resolve));

  await sleep(Number(opt('at')) * 1000);
  const t0 = Date.now();
  docker([action, target]);
  const exited = Date.now();
  await finished;

  const dir = [...out.matchAll(/k6\/reports\/[^\s/]+/g)].at(-1)?.[0];
  if (!dir) throw new Error('no k6 report directory in its output');
  const summary = readFileSync(`${root}${dir}/summary.txt`, 'utf8');
  const failures = readFileSync(`${root}${dir}/failures.ndjson`, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Failure);

  const logs = spawnSync(
    'docker',
    ['logs', '--since', startedAt.toISOString(), 'drills_nginx'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const access = logs.stdout
    .split('\n')
    .map((line) => line.split(' '))
    .filter((f) => /^\d+\.\d+$/.test(f[0]))
    .map((f) => ({
      ms: Math.round(Number(f[0]) * 1000) - t0,
      status: f[1],
      upstream: f[4].replace('upstream=', ''),
    }))
    .filter((r) => r.ms >= 0);
  const toDead = access.filter((r) => r.upstream.includes(`${ip}:3002`));
  const retried = toDead.filter((r) => r.upstream.includes(','));
  const errors = logs.stderr
    .split('\n')
    .filter((line) => /\[(error|warn)\]/.test(line));

  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  console.log(
    `\n  blip: docker ${action} ${target} (${ip}) at ${new Date(t0).toISOString()}, returned after ${s(exited - t0)}`,
  );
  console.log(summary.split('\n').slice(1, 10).join('\n'));
  const by = (pick: (f: Failure) => string) =>
    failures.reduce<Record<string, number>>((acc, f) => {
      acc[pick(f)] = (acc[pick(f)] ?? 0) + 1;
      return acc;
    }, {});
  console.log(
    `\n  failures ${failures.length}  by status ${JSON.stringify(by((f) => String(f.status)))}  by endpoint ${JSON.stringify(by((f) => f.ep))}`,
  );
  if (failures.length) {
    const rel = failures.map((f) => f.t - t0);
    console.log(
      `  failures from ${s(Math.min(...rel))} to ${s(Math.max(...rel))} after the ${action}`,
    );
  }
  console.log(
    `  requests sent to ${ip} after the ${action}: ${toDead.length}, the last at ${toDead.length ? s(Math.max(...toDead.map((r) => r.ms))) : '-'} (${retried.length} retried on another peer)`,
  );
  console.log(`  nginx warn/error lines: ${errors.length}`);
  for (const line of errors.slice(0, 6))
    console.log(`    ${line.slice(0, 170)}`);
}

function down(): void {
  docker(['compose', '--profile', 'replicas', 'rm', '-sfv', 'api', 'nginx']);
}

if (sub === 'up') await up();
else if (sub === 'spread') await spread();
else if (sub === 'holder') {
  const h = holder();
  console.log(h ? `  ${h} → ${byHost(h)}` : '  no holder');
} else if (sub === 'chaos') await chaos();
else if (sub === 'blip') await blip();
else down();
