import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

const envFile = fileURLToPath(new URL('.env', root));
if (existsSync(envFile)) process.loadEnvFile(envFile);

interface Knob {
  flag: string;
  env: string;
  def: string;
  help: string;
}

interface Script {
  file: string;
  blurb: string;
  knobs: Knob[];
}

const COMMON: Knob[] = [
  { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org to hit' },
  { flag: 'vus', env: 'VUS', def: '10', help: 'concurrent virtual users' },
  { flag: 'warmup', env: 'WARMUP', def: '20s', help: 'discarded first phase' },
  { flag: 'duration', env: 'DURATION', def: '60s', help: 'measured phase' },
  { flag: 'name', env: 'NAME', def: '', help: 'labels the run and its report' },
  {
    flag: 'base-url',
    env: 'BASE_URL',
    def: 'http://nest_server:3002',
    help: 'the API, as seen from inside the k6 container',
  },
  {
    flag: 'p95',
    env: 'P95_BUDGET_MS',
    def: '',
    help: 'fail the run past this p95 (exit 99); off by default',
  },
];

const SCRIPTS: Record<string, Script> = {
  list: {
    file: 'conversations-baseline.ts',
    blurb: 'GET /conversations, one page, fixed concurrency (drill 05)',
    knobs: [
      { flag: 'page', env: 'PAGE', def: '1', help: 'which page' },
      { flag: 'page-size', env: 'PAGE_SIZE', def: '20', help: 'rows per page' },
    ],
  },

  search: {
    file: 'messages-search.ts',
    blurb: 'GET /messages/search under load (drill 11)',
    knobs: [
      { flag: 'q', env: 'Q', def: 'export', help: 'the search term' },
      { flag: 'page-size', env: 'PAGE_SIZE', def: '20', help: 'rows per page' },
    ],
  },
};

const die: (message: string) => never = (message) => {
  console.error(message);
  process.exit(1);
};

function help(name: string, script: Script): string {
  const knobs = [...script.knobs, ...COMMON];
  const width = Math.max(...knobs.map((k) => k.flag.length));

  return [
    `${name} — ${script.blurb}   (k6/${script.file})`,
    '',
    'knobs   (--flag value, or NAME=value in the environment)',
    ...knobs.map(
      (k) =>
        `  --${k.flag.padEnd(width + 2)} ${(k.def || '(unset)').padEnd(24)} ${k.help}`,
    ),
    '',
    'anything after -- goes to `k6 run`, e.g. `pnpm load list -- --vus 5`',
  ].join('\n');
}

const [name, ...rest] = process.argv.slice(2);

const script: Script | null =
  (name ? SCRIPTS[name] : undefined) ??
  (name?.endsWith('.ts') && existsSync(new URL(`k6/${name}`, root))
    ? { file: name, blurb: 'not in the catalog', knobs: [] }
    : null);

if (!script) {
  die(
    `usage: node scripts/load.ts <${Object.keys(SCRIPTS).join('|')}|some-script.ts> [--flags] [-- k6 args]`,
  );
}

const knobs = [...script.knobs, ...COMMON];

const options: Record<string, { type: 'string' | 'boolean'; short?: string }> =
  {
    help: { type: 'boolean', short: 'h' },
  };
for (const k of knobs) options[k.flag] = { type: 'string' };

const parse = (args: string[]) => {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    die(`${message.split('. ')[0]}\n\n${help(name, script)}`);
  }
};

const { values, positionals } = parse(rest);

if (values.help) {
  console.log(help(name, script));
  process.exit(0);
}

const env: Record<string, string> = {};
for (const k of knobs) {
  const value = values[k.flag] || process.env[k.env] || k.def;
  if (value) env[k.env] = String(value);
}

const NAME = (env.NAME || '')
  .trim()
  .replace(/[^a-zA-Z0-9._]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (NAME) env.NAME = NAME;
else delete env.NAME;

const p = (n: number) => String(n).padStart(2, '0');
const d = new Date();
const stamp =
  `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
  `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

const RUN =
  `${stamp}${NAME ? `-${NAME}` : ''}` +
  `-${script.file.replace(/\.ts$/, '')}` +
  `-org${env.ORG_ID}-vus${env.VUS}-page${env.PAGE ?? '1'}` +
  `-size${env.PAGE_SIZE ?? '20'}-${env.DURATION}`;

const reportDir = new URL(`k6/reports/${RUN}/`, root);
mkdirSync(reportDir, { recursive: true });

const containerEnv: Record<string, string> = {
  ...env,
  SUMMARY_OUT: `/scripts/reports/${RUN}/summary.txt`,
  K6_WEB_DASHBOARD: 'true',
  K6_WEB_DASHBOARD_PERIOD: '2s',
  K6_WEB_DASHBOARD_EXPORT: `/scripts/reports/${RUN}/dashboard.html`,
};

interface Info {
  arms?: Record<string, string> | null;
}

const infoUrl = `http://localhost:${process.env.BACKEND_PORT || 3002}/info`;
const arms = await fetch(infoUrl, { signal: AbortSignal.timeout(2000) })
  .then((response) => (response.ok ? (response.json() as Promise<Info>) : null))
  .then((body) => body?.arms ?? null)
  .catch(() => null);

if (!arms) console.warn(`no arm state from ${infoUrl} — recording arms: null`);

const gitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
}).stdout?.trim();

writeFileSync(
  new URL('run.json', reportDir),
  JSON.stringify(
    {
      instrument: 'k6',
      script: script.file,
      name: NAME || null,
      at: new Date().toISOString(),
      gitSha: gitSha || null,
      knobs: env,
      arms,
    },
    null,
    2,
  ) + '\n',
);

console.log(`k6/reports/${RUN}/\n`);
if (arms) console.log(`server arms: ${JSON.stringify(arms)}\n`);

const { status, error } = spawnSync(
  'docker',
  [
    'compose',
    '--profile',
    'test',
    'run',
    '--rm',
    ...Object.entries(containerEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    'k6',
    'run',
    `/scripts/${script.file}`,
    ...positionals,
  ],
  { stdio: 'inherit' },
);

if (error) die(`could not run docker: ${error.message}`);

process.exit(status ?? 1);
