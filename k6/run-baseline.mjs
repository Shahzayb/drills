// Runs a k6 script in the pinned container on the Compose network. Was
// `pnpm load:baseline`'s inline shell one-liner.
//
//   pnpm load:baseline                          conversations-baseline.js
//   node k6/run-baseline.mjs messages-search.js  card 11's search endpoint
//   ORG_ID=150 pnpm load:baseline                tail org
//   PAGE=100 PAGE_SIZE=50 pnpm load:baseline      page depth / size
//   NAME=tracing-off pnpm load:baseline          labels the report
//   node k6/run-baseline.mjs other.js           any script in k6/
//   node k6/run-baseline.mjs other.js --vus 5   trailing args go to `k6 run`
//
// This is NOT the old sweep driver of the same name (removed 2026-08-13, see the
// "Revised after shipping" section of
// plans/2026-08-13_drill-05-load-test-baseline.md). It runs exactly one run and
// enforces no order. The VACUUM (ANALYZE) and the settle before a sweep are
// still yours to run, and skipping them moves the whale's count(*) by 2x.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const [script = 'conversations-baseline.js', ...k6Args] = process.argv.slice(2);

// Fail here rather than 5s later inside the container, where a typo reads as a
// k6 error instead of a missing file.
if (!existsSync(new URL(script, import.meta.url))) {
  console.error(`k6/${script} does not exist`);
  process.exit(1);
}

// The knobs conversations-baseline.js reads, defaulted to match it. Forwarded to
// whatever script runs — a script that ignores them is unaffected, which is what
// keeps this runner generic. VUS, DURATION, PAGE and PAGE_SIZE are also read
// here, because the report filename is built from them.
const ORG_ID = process.env.ORG_ID || '1';
const VUS = process.env.VUS || '10';
const WARMUP = process.env.WARMUP || '20s';
const DURATION = process.env.DURATION || '60s';
const PAGE = process.env.PAGE || '1';
const PAGE_SIZE = process.env.PAGE_SIZE || '20';
const P95_BUDGET_MS = process.env.P95_BUDGET_MS;

// Which arm of an A/B this run is — the one thing the filename could never
// reconstruct, and the reason 21 reports had to be dropped in the 2026-08-14
// cleanup (see k6/reports/README.md). Empty by default: an unnamed run is still
// a valid run, and forcing a label on a smoke test would just produce noise.
// Squashed to filename-safe characters so the report name and the printed
// summary say the same thing.
const NAME = (process.env.NAME || '')
  .trim()
  .replace(/[^a-zA-Z0-9._]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Local time, not UTC: a run at 11pm belongs to the evening you ran it, and the
// plan's finding 4 is that runs are only comparable within one sitting. Leading,
// so the directory sorts into sweeps. To the second, because that is what makes a
// filename unique — it used to be a hand-chosen RUN number instead, and a re-run
// under the same one overwrote a recorded one and cost the whole sweep. See the
// "Process note".
const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp =
  `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
  `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

// Every knob that changes the measurement is in the name, including which script
// produced it. NAME sits right after the stamp so labelled runs of one sweep sort
// together under it; without one the name is exactly what it was before.
//
// It names a *directory* now, one per run: the dashboard is 170KB of HTML and is
// gitignored, so what a run leaves in the tree is the summary next to it. Same
// name, so the two are obviously the same run.
const scriptName = script.replace(/\.js$/, '');
const RUN =
  `${stamp}${NAME ? `-${NAME}` : ''}` +
  `-${scriptName}-org${ORG_ID}-vus${VUS}-page${PAGE}-size${PAGE_SIZE}-${DURATION}`;

// k6 writes the dashboard at the *end* of the run and fails the output if the
// directory is missing, so a forgotten mkdir costs the full run, not its first
// second. Same for the summary — handleSummary does not create directories.
mkdirSync(new URL(`reports/${RUN}/`, import.meta.url), { recursive: true });

// Card 11's knob. Forwarded unconditionally like the rest — a script that does
// not read it is unaffected, which is the whole reason this runner is generic.
// It is NOT in the report filename: a search term can be any text, and the
// filename is a filename. messages-search.js prints it in the summary instead.
const Q = process.env.Q || 'export';
// Both k6 scripts read it, so it is a knob whether or not anyone sets it. The
// default is the Compose service name, which is where k6 runs.
const BASE_URL = process.env.BASE_URL || 'http://nest_server:3002';

const env = {
  ORG_ID,
  VUS,
  WARMUP,
  DURATION,
  PAGE,
  PAGE_SIZE,
  NAME,
  Q,
  BASE_URL,
};
if (P95_BUDGET_MS) env.P95_BUDGET_MS = P95_BUDGET_MS;

// Where the script's handleSummary writes its block. A script without one just
// ignores this, same as the knobs above.
env.SUMMARY_OUT = `/scripts/reports/${RUN}/summary.txt`;

// k6's own web dashboard, self-contained HTML. Worth generating: percentiles are
// a single point in time, and only the time series separates a uniformly slow run
// from one that stalled for five seconds. Worth generating, not worth committing
// — 170KB each, and the numbers a plan cites are all in summary.txt.
Object.assign(env, {
  K6_WEB_DASHBOARD: 'true',
  K6_WEB_DASHBOARD_PERIOD: '2s',
  K6_WEB_DASHBOARD_EXPORT: `/scripts/reports/${RUN}/dashboard.html`,
});

const args = [
  'compose',
  '--profile',
  'test',
  'run',
  '--rm',
  ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  'k6',
  'run',
  `/scripts/${script}`,
  ...k6Args,
];

// The arm state the API is serving, and the commit under test. Both are read
// before k6 starts, so neither touches the measured window. A number whose arm
// and checkout cannot be recovered is a number that gets retyped into prose
// with its conditions left behind — drill 08's README defect.
const arms = await fetch(
  `http://localhost:${process.env.BACKEND_PORT || 3002}/info`,
)
  .then((response) => (response.ok ? response.json() : null))
  .then((body) => body?.arms ?? null)
  .catch(() => null);

const gitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
}).stdout?.trim();

writeFileSync(
  new URL(`reports/${RUN}/run.json`, import.meta.url),
  JSON.stringify(
    {
      instrument: 'k6',
      script,
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

const { status, error } = spawnSync('docker', args, { stdio: 'inherit' });

if (error) throw error;

// k6 exits 99 on a failed threshold — a real result (errors in the run, or a
// P95_BUDGET_MS miss), so it propagates rather than being swallowed.
process.exit(status ?? 1);
