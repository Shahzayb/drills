import { check } from 'k6';
import http from 'k6/http';

/**
 * Drill 11 — GET /messages/search under load, same method as
 * conversations-baseline.js so the two are readable side by side.
 *
 * The only reason this is a separate file rather than a knob on the baseline is
 * that the baseline's recorded runs must keep measuring the same URL. See
 * plans/2026-08-13_drill-05-load-test-baseline.md.
 *
 * Which arm answers is not set here. It is `SEARCH_STRATEGY` on the *server*, so
 * an A/B is two runs with a `docker compose up -d nest_server` between them:
 *
 *   SEARCH_STRATEGY=like docker compose up -d nest_server
 *   NAME=like  Q=export node k6/run-baseline.mjs messages-search.js
 *   docker compose up -d nest_server
 *   NAME=fts   Q=export node k6/run-baseline.mjs messages-search.js
 *
 * Q is the term, and it changes the measurement more than any other knob: a 4%
 * selective term and a 0.05% one are two different queries wearing one URL.
 */

const BASE_URL = __ENV.BASE_URL || 'http://nest_server:3002';
const NAME = __ENV.NAME || '';
const ORG_ID = __ENV.ORG_ID || '1';
const VUS = Number(__ENV.VUS || 10);
const WARMUP = __ENV.WARMUP || '20s';
const DURATION = __ENV.DURATION || '60s';
const Q = __ENV.Q || 'export';
// Named PAGE_SIZE rather than LIMIT so one runner knob feeds both scripts and
// the report filename keeps meaning what it says.
const LIMIT = Number(__ENV.PAGE_SIZE || 20);

const P95_BUDGET_MS = __ENV.P95_BUDGET_MS;
const SUMMARY_OUT = __ENV.SUMMARY_OUT;

const URL = `${BASE_URL}/messages/search?q=${encodeURIComponent(Q)}&limit=${LIMIT}`;

/** '60s' -> 60. Only ever fed the DURATION above. */
const seconds = (s) => Number(String(s).replace('s', ''));

// A tagged sub-metric is not computed in k6 unless a threshold names it, so
// these declare the sub-metric rather than pass or fail. Without them the
// warm-up cannot be excluded at all.
const MEASURED_DURATION = 'http_req_duration{scenario:measure}';
const MEASURED_REQS = 'http_reqs{scenario:measure}';

const durationThresholds = ['max>=0'];
if (P95_BUDGET_MS) durationThresholds.push(`p(95)<${P95_BUDGET_MS}`);

export const options = {
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
    'http_req_failed{scenario:measure}': ['rate<0.01'],
  },
};

export default function () {
  // No sleep(), same as the baseline: closed-loop, so queueing delay lands in
  // the p99 where a baseline wants it.
  const res = http.get(URL, { headers: { 'x-org-id': ORG_ID } });
  check(res, { 'status is 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  const measured = data.metrics[MEASURED_DURATION];
  const reqs = data.metrics[MEASURED_REQS];
  const overall = data.metrics.http_req_duration;

  const v = measured.values;
  const count = reqs.values.count;

  // Per measured second. k6's own counter rate divides by the whole run,
  // warm-up included, and understates this by 25%.
  const rps = count / seconds(DURATION);

  const n = (x) => x.toFixed(2);

  const report = [
    '',
    `  ${NAME ? `name=${NAME} ` : ''}org=${ORG_ID} vus=${VUS} warmup=${WARMUP} measured=${DURATION} q=${Q} limit=${LIMIT}`,
    `  measured requests : ${count}`,
    `  p50 / p95 / p99   : ${n(v.med)} / ${n(v['p(95)'])} / ${n(v['p(99)'])} ms`,
    `  min / avg / max   : ${n(v.min)} / ${n(v.avg)} / ${n(v.max)} ms`,
    `  throughput        : ${n(rps)} req/s`,
    `  (incl. warm-up)   : p50 ${n(overall.values.med)}  p95 ${n(overall.values['p(95)'])}  p99 ${n(overall.values['p(99)'])} ms`,
    '',
    // Same column order as conversations-baseline.js up to the run params, with
    // `q` where page/pageSize sit there. Rows from the two scripts are not
    // interchangeable and the filename says which produced them.
    `RESULT,${NAME},${ORG_ID},${VUS},${Q},${LIMIT},${n(v.med)},${n(v['p(95)'])},${n(v['p(99)'])},${n(rps)},${count}`,
    '',
  ].join('\n');

  return SUMMARY_OUT
    ? { stdout: report, [SUMMARY_OUT]: report }
    : { stdout: report };
}
