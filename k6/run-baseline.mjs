// Runs a k6 script in the pinned container on the Compose network. Was
// `pnpm load:baseline`'s inline shell one-liner.
//
//   pnpm load:baseline                          conversations-baseline.js
//   ORG_ID=150 pnpm load:baseline                tail org
//   node k6/run-baseline.mjs other.js           any script in k6/
//   node k6/run-baseline.mjs other.js --vus 5   trailing args go to `k6 run`
//
// This is NOT the old sweep driver of the same name (removed 2026-08-13, see the
// "Revised after shipping" section of
// plans/2026-08-13_drill-05-load-test-baseline.md). It runs exactly one run and
// enforces no order. The VACUUM (ANALYZE) and the settle before a sweep are
// still yours to run, and skipping them moves the whale's count(*) by 2x.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const [script = 'conversations-baseline.js', ...k6Args] = process.argv.slice(2);

// Fail here rather than 5s later inside the container, where a typo reads as a
// k6 error instead of a missing file.
if (!existsSync(new URL(script, import.meta.url))) {
  console.error(`k6/${script} does not exist`);
  process.exit(1);
}

// The knobs conversations-baseline.js reads, defaulted to match it. Forwarded to
// whatever script runs — a script that ignores them is unaffected, which is what
// keeps this runner generic. VUS and DURATION are also read here, because the
// report filename is built from them.
const ORG_ID = process.env.ORG_ID || '1';
const VUS = process.env.VUS || '10';
const WARMUP = process.env.WARMUP || '20s';
const DURATION = process.env.DURATION || '60s';
const P95_BUDGET_MS = process.env.P95_BUDGET_MS;

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
// produced it.
const name = script.replace(/\.js$/, '');
const REPORT = `${stamp}-${name}-org${ORG_ID}-vus${VUS}-${DURATION}.html`;

// k6 writes the dashboard at the *end* of the run and fails the output if the
// directory is missing, so a forgotten mkdir costs the full run, not its first
// second.
mkdirSync(new URL('reports/', import.meta.url), { recursive: true });

const env = { ORG_ID, VUS, WARMUP, DURATION };
if (P95_BUDGET_MS) env.P95_BUDGET_MS = P95_BUDGET_MS;

// k6's own web dashboard, self-contained HTML. The one output worth keeping:
// percentiles are a single point in time, and only the time series separates a
// uniformly slow run from one that stalled for five seconds.
Object.assign(env, {
  K6_WEB_DASHBOARD: 'true',
  K6_WEB_DASHBOARD_PERIOD: '2s',
  K6_WEB_DASHBOARD_EXPORT: `/scripts/reports/${REPORT}`,
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

console.log(`k6/reports/${REPORT}\n`);

const { status, error } = spawnSync('docker', args, { stdio: 'inherit' });

if (error) throw error;

// k6 exits 99 on a failed threshold — a real result (errors in the run, or a
// P95_BUDGET_MS miss), so it propagates rather than being swallowed.
process.exit(status ?? 1);
