import { check } from 'k6';
import http from 'k6/http';

/**
 * The measurement method, shared by every script in k6/.
 *
 * A script in k6/ is now a URL and one line of summary. Everything about *how*
 * the number is produced — the warm-up split, the tagged sub-metrics, the
 * thresholds, the p99 arithmetic — lives here, once.
 *
 * This file is what lets two scripts claim to be the same experiment. They used
 * to each carry a copy of all of it, and messages-search.js already said in its
 * header that the only reason it was a separate file was the URL. It was 90%
 * the same file, which means the claim was true and unenforced.
 *
 * The knobs below are defaulted HERE and declared again in the catalog in
 * scripts/load.mjs, because a k6 script has to be runnable by hand. Two copies
 * of a default is the exact bug this branch is about, so scripts/check-arms.mjs
 * fails when the two disagree.
 *
 * See plans/2026-08-13_drill-05-load-test-baseline.md before changing any of
 * them — a change here silently invalidates every recorded run in k6/reports/.
 *
 * Runs in the k6 CONTAINER. See plans/2026-08-30_instrument-hardening.md § 7.
 */

export const BASE_URL = __ENV.BASE_URL || 'http://nest_server:3002';
// The arm of an A/B this run is, set by scripts/load.mjs (which also puts it in
// the report directory name). Empty by default — it labels the output and
// changes nothing about the measurement.
export const NAME = __ENV.NAME || '';
export const ORG_ID = __ENV.ORG_ID || '1';
export const VUS = Number(__ENV.VUS || '10');
export const WARMUP = __ENV.WARMUP || '20s';
export const DURATION = __ENV.DURATION || '60s';
export const PAGE = Number(__ENV.PAGE || '1');
export const PAGE_SIZE = Number(__ENV.PAGE_SIZE || '20');
export const Q = __ENV.Q || 'export';

// Stretch goal / card 31: fails the run if the measured p95 goes past a stated
// number. Off unless set, because a failed threshold exits 99 and would abort a
// sweep halfway through — a pass/fail gate and a measurement run are two
// different jobs for the same script.
const P95_BUDGET_MS = __ENV.P95_BUDGET_MS;

// Set by scripts/load.mjs to the run's own directory. Unset when the script is
// run by hand, and then the summary is printed and not written.
const SUMMARY_OUT = __ENV.SUMMARY_OUT;

// In k6 a tagged sub-metric is NOT computed unless a threshold names it, so the
// two entries below exist to *declare* the sub-metric, not to pass or fail —
// they cannot fail. Without them, data.metrics has no per-scenario breakdown
// and the warm-up cannot be excluded at all.
const MEASURED_DURATION = 'http_req_duration{scenario:measure}';
const MEASURED_REQS = 'http_reqs{scenario:measure}';

const durationThresholds = ['max>=0'];
if (P95_BUDGET_MS) durationThresholds.push(`p(95)<${P95_BUDGET_MS}`);

export const options = {
  // Warm-up runs first and its metrics are thrown away: JIT warm-up, the pg
  // pool opening its 10 connections, and Postgres pulling pages into
  // shared_buffers all happen once and would otherwise land in run 1's p99.
  //
  // gracefulStop: '0s' on warmup makes the two scenarios strictly
  // non-overlapping, so k6 allocates 10 VUs rather than 20. It cuts off at most
  // 10 in-flight warm-up requests, which are tagged scenario:warmup and
  // excluded from every reported number regardless.
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: VUS,
      duration: WARMUP,
      gracefulStop: '0s',
    },
    measure: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      startTime: WARMUP,
    },
  },

  // k6's default summary stops at p(95). This line is the only reason p99 —
  // the number the cards are actually about — appears anywhere.
  summaryTrendStats: [
    'min',
    'med',
    'p(90)',
    'p(95)',
    'p(99)',
    'max',
    'avg',
    'count',
  ],

  thresholds: {
    [MEASURED_DURATION]: durationThresholds,
    [MEASURED_REQS]: ['count>0'],
    // This one is a real assertion. A run containing errors is not a baseline.
    'http_req_failed{scenario:measure}': ['rate<0.01'],
  },
};

/**
 * One request, checked. No sleep(): closed-loop, each VU sending the next
 * request the instant the last returns. That measures saturation throughput and
 * puts queueing delay in the p99, which is what a *baseline* should capture.
 */
export function request(url) {
  const res = http.get(url, { headers: { 'x-org-id': ORG_ID } });
  check(res, { 'status is 200': (r) => r.status === 200 });
}

/** '60s' -> 60. Only ever fed the DURATION above. */
const seconds = (s) => Number(String(s).replace('s', ''));

/**
 * The summary block, byte-identical to what the run printed — a summary built
 * twice is a summary that can disagree with the terminal.
 *
 * `params` is the script's own tail of the parameter line, and `columns` its
 * own middle columns of the RESULT row. Everything else is fixed, so rows from
 * different scripts line up as far as they can and the report directory name
 * says which script produced them.
 */
export function summary(data, { params, columns }) {
  const v = data.metrics[MEASURED_DURATION].values;
  const count = data.metrics[MEASURED_REQS].values.count;
  const overall = data.metrics.http_req_duration.values;

  // NOT the counter's own rate. k6 divides a counter's rate by the *whole* run
  // duration, warm-up included — 80s here, not 60s — which understates the
  // measured phase by 25%. Throughput is per measured second or it is wrong.
  const rps = count / seconds(DURATION);

  const n = (x) => x.toFixed(2);

  const report = [
    '',
    `  ${NAME ? `name=${NAME} ` : ''}org=${ORG_ID} vus=${VUS} warmup=${WARMUP} measured=${DURATION} ${params}`,
    `  measured requests : ${count}`,
    `  p50 / p95 / p99   : ${n(v.med)} / ${n(v['p(95)'])} / ${n(v['p(99)'])} ms`,
    `  min / avg / max   : ${n(v.min)} / ${n(v.avg)} / ${n(v.max)} ms`,
    `  throughput        : ${n(rps)} req/s`,
    // Printed side by side so warm-up exclusion is visible rather than claimed.
    // If these two lines are identical, the exclusion is not working.
    `  (incl. warm-up)   : p50 ${n(overall.med)}  p95 ${n(overall['p(95)'])}  p99 ${n(overall['p(99)'])} ms`,
    '',
    // Machine-readable row, for wherever the table is being kept. NAME leads —
    // an empty leading field keeps every other column where it was. Rows
    // recorded before PAGE/PAGE_SIZE existed have two fewer columns.
    `RESULT,${NAME},${ORG_ID},${VUS},${columns.join(',')},${n(v.med)},${n(v['p(95)'])},${n(v['p(99)'])},${n(rps)},${count}`,
    '',
  ].join('\n');

  return SUMMARY_OUT
    ? { stdout: report, [SUMMARY_OUT]: report }
    : { stdout: report };
}
