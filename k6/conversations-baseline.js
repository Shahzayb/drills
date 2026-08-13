import { check } from 'k6';
import http from 'k6/http';

/**
 * Drill 05 baseline — GET /conversations, one page, fixed concurrency.
 *
 * The point of this file is not the load. It is that the *method* is fixed, so
 * the number it prints tonight is comparable to the number it prints in eight
 * weeks. Every knob below is either an env var (so a run is described by its
 * command line) or a constant with a reason. See
 * plans/2026-08-13_drill-05-load-test-baseline.md before changing any of them —
 * a change here silently invalidates every recorded run.
 *
 * The only file a run leaves behind is k6/reports/<run>.html, k6's own web
 * dashboard. `pnpm load:baseline` is what turns it on; this script just prints.
 */

const BASE_URL = __ENV.BASE_URL || 'http://nest_server:3002';
const ORG_ID = __ENV.ORG_ID || '1';
const VUS = Number(__ENV.VUS || 10);
const WARMUP = __ENV.WARMUP || '20s';
const DURATION = __ENV.DURATION || '60s';

// Stretch goal / card 31: fails the run if the measured p95 goes past a stated
// number. Off unless set, because a failed threshold exits 99 and would abort
// the sweep halfway through — a pass/fail gate and a measurement run are two
// different jobs for the same script.
const P95_BUDGET_MS = __ENV.P95_BUDGET_MS;

const URL = `${BASE_URL}/conversations?page=1&pageSize=20`;

/** '60s' -> 60. Only ever fed the DURATION above. */
const seconds = (s) => Number(String(s).replace('s', ''));

// Sub-metrics for the measured phase. In k6 a tagged sub-metric is NOT computed
// unless a threshold names it, so these two exist to *declare* the sub-metric,
// not to pass or fail — they cannot fail. Without them, data.metrics has no
// per-scenario breakdown and the warm-up cannot be excluded at all.
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
  // the number the card is actually about — appears anywhere.
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

export default function () {
  // No sleep(): 10 VUs closed-loop, each sending the next request the instant
  // the last returns. Measures saturation throughput and puts queueing delay in
  // the p99, which is what we want a *baseline* to capture.
  const res = http.get(URL, { headers: { 'x-org-id': ORG_ID } });
  check(res, { 'status is 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  const measured = data.metrics[MEASURED_DURATION];
  const reqs = data.metrics[MEASURED_REQS];
  const overall = data.metrics.http_req_duration;

  const v = measured.values;
  const count = reqs.values.count;

  // NOT reqs.values.rate. k6 divides a counter's rate by the *whole* run
  // duration, warm-up included — 80s here, not 60s — which understates the
  // measured phase by 25%. Throughput is per measured second or it is wrong.
  const rps = count / seconds(DURATION);

  const n = (x) => x.toFixed(2);

  const report = [
    '',
    `  org=${ORG_ID} vus=${VUS} warmup=${WARMUP} measured=${DURATION}`,
    `  measured requests : ${count}`,
    `  p50 / p95 / p99   : ${n(v.med)} / ${n(v['p(95)'])} / ${n(v['p(99)'])} ms`,
    `  min / avg / max   : ${n(v.min)} / ${n(v.avg)} / ${n(v.max)} ms`,
    `  throughput        : ${n(rps)} req/s`,
    // Printed side by side so warm-up exclusion is visible rather than claimed.
    // If these two lines are identical, the exclusion is not working.
    `  (incl. warm-up)   : p50 ${n(overall.values.med)}  p95 ${n(overall.values['p(95)'])}  p99 ${n(overall.values['p(99)'])} ms`,
    '',
    // Machine-readable row, for wherever the table is being kept.
    `RESULT,${ORG_ID},${VUS},${n(v.med)},${n(v['p(95)'])},${n(v['p(99)'])},${n(rps)},${count}`,
    '',
  ].join('\n');

  return { stdout: report };
}
