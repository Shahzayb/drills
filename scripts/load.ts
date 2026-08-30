// Runs a k6 script in the pinned container on the Compose network.
// `pnpm load list`, `pnpm load search --q ERR_2452`, `pnpm load list --org 150`.
//
// Was k6/run-baseline.mjs, which ran on the HOST out of the directory reserved
// for what runs in the container — the one invariant phase 2 of
// plans/2026-08-30_instrument-hardening.md exists to state. It also carried a
// second copy of every default in k6/lib/scenario.ts, hand-rolled its env
// plumbing, and had no --help, so the only way to learn a knob was to read it.
//
// Same shape as scripts/measure.ts: one catalog, generated -e flags, parseArgs.
// This is NOT a sweep driver (the old one of that name was removed 2026-08-13,
// see the "Revised after shipping" section of
// plans/2026-08-13_drill-05-load-test-baseline.md). It runs exactly one run and
// enforces no order. The VACUUM (ANALYZE) and the settle before a sweep are
// still yours to run, and skipping them moves the whale's count(*) by 2x.
//
// Runs on the HOST. See plans/2026-08-30_instrument-hardening.md section 7.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

// This runs on the host, where nothing loads .env — Compose reads it itself, so
// BACKEND_PORT=4000 there publishes 4000 while plain Node still reads 3002,
// finds nothing, and records `arms: null` in every run.json without a word. The
// shell still wins over the file.
const envFile = fileURLToPath(new URL('.env', root));
if (existsSync(envFile)) process.loadEnvFile(envFile);

interface Knob {
  /** The `--flag` spelling. */
  flag: string;
  /** The `__ENV` name k6 reads it back as. */
  env: string;
  /** Forwarded even when nobody set it — the report directory name needs it. */
  def: string;
  help: string;
}

interface Script {
  file: string;
  blurb: string;
  knobs: Knob[];
}

// Read by lib/scenario.ts, so every script gets them whichever one runs.
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
    // Filenames stay as they are apart from the extension: ~60 recorded report
    // directories are named after them and the plans cite those names. The
    // directory name is built by stripping `.ts` below, so it is unchanged.
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

// Annotated on the const, not on the arrow: TypeScript only lets a `never`
// return narrow the code after the call when the *variable* carries the type.
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

// ------------------------------------------------------------------- dispatch

const [name, ...rest] = process.argv.slice(2);

// A script not in the catalog still runs, with the common knobs only. Keeps a
// scratch file in k6/ usable without an entry it does not need yet.
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

// An arrow on a const, not a function declaration: a hoisted declaration does
// not see that the `if` above already narrowed script away from null.
const parse = (args: string[]) => {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    // parseArgs' own message trails into advice about `--` and positional
    // arguments, which is not the reader's problem. The knob list is.
    const message = error instanceof Error ? error.message : String(error);
    die(`${message.split('. ')[0]}\n\n${help(name, script)}`);
  }
};

const { values, positionals } = parse(rest);

if (values.help) {
  console.log(help(name, script));
  process.exit(0);
}

// -------------------------------------------------------------- resolve knobs

// A flag beats the environment beats the catalog default. Unlike
// scripts/measure.ts, the default IS forwarded: the report directory name is
// built from these values, so the runner has to know them, and a k6 summary
// prints values rather than provenance. lib/scenario.ts keeps a matching set
// for hand-runs, and `pnpm check:arms` fails when the two disagree.
//
// `||` and not `??`, the same rule db/lib/run.mts states: an unset variable
// forwarded by a shell arrives as the empty string, not as absent. With `??`
// that empty string beat the default, dropped out at the `if` below, and named
// the run directory `-orgundefined-` while the container measured org 1.
const env: Record<string, string> = {};
for (const k of knobs) {
  const value = values[k.flag] || process.env[k.env] || k.def;
  if (value) env[k.env] = String(value);
}

// Squashed to filename-safe characters so the report name and the printed
// summary say the same thing.
const NAME = (env.NAME || '')
  .trim()
  .replace(/[^a-zA-Z0-9._]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (NAME) env.NAME = NAME;
else delete env.NAME;

// Local time, not UTC: a run at 11pm belongs to the evening you ran it, and the
// plan's finding 4 is that runs are only comparable within one sitting. Leading,
// so the directory sorts into sweeps. To the second, because that is what makes
// a filename unique — it used to be a hand-chosen RUN number instead, and a
// re-run under the same one overwrote a recorded one and cost the whole sweep.
const p = (n: number) => String(n).padStart(2, '0');
const d = new Date();
const stamp =
  `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
  `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

// Unchanged from run-baseline.mjs, deliberately: ~60 recorded directories carry
// this exact shape and a run is compared to them by name. The `.ts` strip is
// what keeps that true across the TypeScript conversion — the directory still
// says `conversations-baseline`. `page` is in it even for a script that has no
// page, which is why it falls back rather than reading a knob the catalog may
// not declare.
const RUN =
  `${stamp}${NAME ? `-${NAME}` : ''}` +
  `-${script.file.replace(/\.ts$/, '')}` +
  `-org${env.ORG_ID}-vus${env.VUS}-page${env.PAGE ?? '1'}` +
  `-size${env.PAGE_SIZE ?? '20'}-${env.DURATION}`;

// k6 writes the dashboard at the *end* of the run and fails the output if the
// directory is missing, so a forgotten mkdir costs the full run, not its first
// second. Same for the summary — handleSummary does not create directories.
const reportDir = new URL(`k6/reports/${RUN}/`, root);
mkdirSync(reportDir, { recursive: true });

// ------------------------------------------------------------------- the run

// Plumbing rather than knobs, so it is added after run.json's `knobs` block is
// taken from `env` above. The web dashboard is worth generating — percentiles
// are a single point in time, and only the time series separates a uniformly
// slow run from one that stalled for five seconds — and not worth committing,
// at 170KB each, so it is gitignored.
const containerEnv: Record<string, string> = {
  ...env,
  SUMMARY_OUT: `/scripts/reports/${RUN}/summary.txt`,
  K6_WEB_DASHBOARD: 'true',
  K6_WEB_DASHBOARD_PERIOD: '2s',
  K6_WEB_DASHBOARD_EXPORT: `/scripts/reports/${RUN}/dashboard.html`,
};

/** The `arms` block of GET /info — which A/B arm the API resolved at load. */
interface Info {
  arms?: Record<string, string> | null;
}

// The arm state the API is serving, and the commit under test. Both are read
// before k6 starts, so neither touches the measured window. A number whose arm
// and checkout cannot be recovered is a number that gets retyped into prose
// with its conditions left behind — drill 08's README defect.
//
// Timed out rather than left open: a server that accepts the connection and
// never answers — nest_server mid-recompile, a stale process on the port — has
// no timeout of its own worth waiting for, and this sits in front of the run.
const infoUrl = `http://localhost:${process.env.BACKEND_PORT || 3002}/info`;
const arms = await fetch(infoUrl, { signal: AbortSignal.timeout(2000) })
  .then((response) => (response.ok ? (response.json() as Promise<Info>) : null))
  .then((body) => body?.arms ?? null)
  .catch(() => null);

// Recorded runs are the point, so say it rather than leaving a null in the file.
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

// k6 exits 99 on a failed threshold — a real result (errors in the run, or a
// P95_BUDGET_MS miss), so it propagates rather than being swallowed.
process.exit(status ?? 1);
