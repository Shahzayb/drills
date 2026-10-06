import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import {
  BASE_URL,
  ORG_ID,
  PAGE_SIZE,
  Q,
  scenario,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

/**
 * Drill 22 — one fixed read mix, run once per pool size. The server's PG_POOL_MAX is the only
 * variable, so this file must not change between runs of a sweep.
 *
 *   PG_POOL_MAX=16 docker compose up -d nest_server
 *   pnpm load pool --org 2-10 --vus 100 --name pool16
 *
 * `--org` takes a range here, and the requests cycle through it. The default is the whale, whose
 * parallel aggregate exhausts the container's /dev/shm, so pass `--org 2-10`.
 *
 * The pool columns need the API in `QUERY_COUNTER=header` mode; without it they print no samples.
 * See plans/2026-10-06_drill-22-connection-pool-knee.md.
 */

const [lo, hi = lo] = ORG_ID.split('-').map(Number);
if (!(lo > 0 && hi >= lo)) throw new Error(`--org '${ORG_ID}' is not N or N-M`);
const ORGS = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));

// The mix, by iteration number: identical in every run. list is listed twice, so it is half.
const list = `/conversations?page=1&pageSize=${PAGE_SIZE}`;
const MIX = [
  { ep: 'list', path: list },
  { ep: 'list', path: list },
  {
    ep: 'keyset',
    path: `/conversations?paging=keyset&status=open&pageSize=${PAGE_SIZE}`,
  },
  {
    ep: 'search',
    path: `/messages/search?q=${encodeURIComponent(Q)}&limit=${PAGE_SIZE}`,
  },
];
const ENDPOINTS = ['list', 'keyset', 'search'];

const poolWait = new Trend('pool_wait_ms', true);
const poolHold = new Trend('pool_hold_ms', true);

const measured = (metric: string) => `${metric}{scenario:measure}`;
const byEndpoint = (ep: string) =>
  `http_req_duration{scenario:measure,ep:${ep}}`;

export const options = scenario({
  thresholds: {
    // A pool that is too small times out by design. Report the errors; do not abort the sweep.
    [measured('http_req_failed')]: ['rate<=1'],
    // Declarations: k6 computes a tagged sub-metric only when a threshold names it.
    [measured('pool_wait_ms')]: ['max>=0'],
    [measured('pool_hold_ms')]: ['max>=0'],
    ...Object.fromEntries(ENDPOINTS.map((ep) => [byEndpoint(ep), ['max>=0']])),
  },
});

export default function (): void {
  const i = exec.scenario.iterationInTest;
  const { ep, path } = MIX[i % MIX.length];
  const org = ORGS[Math.floor(i / MIX.length) % ORGS.length];

  const res = http.get(`${BASE_URL}${path}`, {
    headers: { 'x-org-id': org },
    tags: { ep },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });

  const wait = res.headers['X-Pool-Wait-Ms'];
  const hold = res.headers['X-Pool-Hold-Ms'];
  if (wait !== undefined) poolWait.add(Number(wait));
  if (hold !== undefined) poolHold.add(Number(hold));
}

export function handleSummary(data: SummaryData) {
  const n = (x: number | undefined) => (x ?? NaN).toFixed(2);
  const wait = data.metrics[measured('pool_wait_ms')]?.values ?? {};
  const hold = data.metrics[measured('pool_hold_ms')]?.values ?? {};
  const p99 = (ep: string) => n(data.metrics[byEndpoint(ep)]?.values['p(99)']);

  return summary(data, {
    params: `mix=list:keyset:search 2:1:1 q=${Q} pageSize=${PAGE_SIZE}`,
    columns: [Q, n(wait.avg), n(wait['p(99)']), n(hold.avg), n(hold['p(99)'])],
    extra: [
      `  pool wait         : p50 ${n(wait.med)} / p99 ${n(wait['p(99)'])} / mean ${n(wait.avg)} ms (${wait.count ?? 0} samples)`,
      `  pool hold         : p50 ${n(hold.med)} / p99 ${n(hold['p(99)'])} / mean ${n(hold.avg)} ms`,
      `  p99 by endpoint   : ${ENDPOINTS.map((ep) => `${ep} ${p99(ep)}`).join(' · ')} ms`,
    ],
  });
}
