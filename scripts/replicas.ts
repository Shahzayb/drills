// Drill 24: N replicas of the API behind nginx, and the chaos that tests the run-once job.
// `pnpm replicas up --scheduler all`, `pnpm replicas chaos --do pause --hold 15`, `pnpm replicas --help`.
//
// Runs on the HOST because it drives Docker. Every docker command is printed before it runs, so each
// step can be repeated by hand. See plans/2026-10-12_drill-24-three-replicas.md.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
} as const;

const KNOBS = {
  scale: { def: '3', help: 'up: how many replicas' },
  n: { def: '300', help: 'spread: requests' },
  do: { def: 'kill', help: 'chaos: kill (SIGKILL) | pause (docker pause)' },
  hold: { def: '15', help: 'chaos: seconds a pause lasts' },
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
      `  ${r.name.padEnd(18)} ${r.id}  ${r.ip.padEnd(12)}  scheduler=${arms.scheduler} rateLimit=${arms.rateLimit} pool=${arms.poolMax} slot=${arms.jobSlotS}s lease=${arms.leaseTtlMs}ms`,
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

function down(): void {
  docker(['compose', '--profile', 'replicas', 'rm', '-sfv', 'api', 'nginx']);
}

if (sub === 'up') await up();
else if (sub === 'spread') await spread();
else if (sub === 'holder') {
  const h = holder();
  console.log(h ? `  ${h} → ${byHost(h)}` : '  no holder');
} else if (sub === 'chaos') await chaos();
else down();
