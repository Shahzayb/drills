import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import {
  API_KEY,
  BASE_URL,
  DURATION,
  ORG_ID,
  PAGE_SIZE,
  Q,
  RATE,
  scenario,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

/**
 * Drill 23 — an open-model mix through the load balancer while `pnpm drain` restarts the replicas.
 *
 * Open model, so a refused request is an error and not a slower VU. Each failure is one JSON line in
 * the report's failures.ndjson (scripts/load.ts points k6's log there), which the orchestrator lines
 * up against the restart. Writes are `k6-drain-*` events on the API key's org.
 */

const [lo, hi = lo] = ORG_ID.split('-').map(Number);
if (!(lo > 0 && hi >= lo)) throw new Error(`--org '${ORG_ID}' is not N or N-M`);
const ORGS = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));

const RUN = `k6-drain-${__ENV.NAME || 'run'}-${Date.now()}`;
const MIX = [
  'list',
  'list',
  'list',
  'list',
  'list',
  'list',
  'search',
  'search',
  'ingest',
  'ingest',
];
const ENDPOINTS = ['list', 'search', 'ingest'];

const measured = (metric: string, ep?: string) =>
  `${metric}{scenario:measure${ep ? `,ep:${ep}` : ''}}`;

export const options = scenario({
  measure: {
    executor: 'constant-arrival-rate',
    rate: RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 50,
    maxVUs: 300,
  },
  thresholds: {
    // A broken arm is the result being measured, so errors report rather than abort.
    [measured('http_req_failed')]: ['rate<=1'],
    ...Object.fromEntries(
      ENDPOINTS.flatMap((ep) => [
        [measured('http_req_duration', ep), ['max>=0']],
        [measured('http_req_failed', ep), ['rate<=1']],
      ]),
    ),
  },
});

export default function (): void {
  const i = exec.scenario.iterationInTest;
  const ep = MIX[i % MIX.length];
  const org = ORGS[Math.floor(i / MIX.length) % ORGS.length];

  const res =
    ep === 'ingest'
      ? http.post(
          `${BASE_URL}/ingest`,
          JSON.stringify({ eventId: `${RUN}-${i}`, message: `k6 drain ${i}` }),
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${API_KEY}`,
            },
            tags: { ep },
          },
        )
      : http.get(
          `${BASE_URL}${
            ep === 'list'
              ? `/conversations?pageSize=${PAGE_SIZE}`
              : `/messages/search?q=${encodeURIComponent(Q)}&limit=${PAGE_SIZE}`
          }`,
          { headers: { 'x-org-id': org }, tags: { ep } },
        );

  const ok = check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  if (!ok) {
    console.log(
      JSON.stringify({
        t: Date.now(),
        ep,
        status: res.status,
        code: res.error_code,
        by: res.headers['X-Served-By'] ?? null,
        ms: Math.round(res.timings.duration),
        scenario: exec.scenario.name,
      }),
    );
  }
}

export function handleSummary(data: SummaryData) {
  const n = (x: number | undefined) => (x ?? NaN).toFixed(2);
  const failed = (ep: string) =>
    data.metrics[measured('http_req_failed', ep)]?.values.passes ?? 0;
  const p99 = (ep: string) =>
    n(data.metrics[measured('http_req_duration', ep)]?.values['p(99)']);

  return summary(data, {
    params: `mix=list:search:ingest 6:2:2 q=${Q} pageSize=${PAGE_SIZE}`,
    columns: [RATE, ...ENDPOINTS.map(failed)],
    extra: [
      `  errors by endpoint: ${ENDPOINTS.map((ep) => `${ep} ${failed(ep)}`).join(' · ')}`,
      `  p99 by endpoint   : ${ENDPOINTS.map((ep) => `${ep} ${p99(ep)}`).join(' · ')} ms`,
    ],
  });
}
