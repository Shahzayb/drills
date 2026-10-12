import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import {
  BASE_URL,
  DURATION,
  MODEL,
  ORG_ID,
  PAGE,
  PAGE_SIZE,
  scenario,
  seconds,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

/**
 * Drill 25 — fast traffic with a small slow slice, so the mean and the p99 disagree.
 *
 *   pnpm load mix --org 150 --model open --rate 100
 *   pnpm load mix --org 150                      # the same mix, closed at 10 VUs
 *   pnpm load mix --org 3 --slow-every 0         # uniform: no slow slice
 *
 * Every SLOW_EVERY-th iteration is SLOW_PATH on SLOW_ORG (the whale's deep offset page); the rest is
 * --org's list. The pick
 * is by iteration number, so the slice is the same share under both models. The summary prints p99
 * three ways: successes only, every answer, and time to success with a failure counted as never.
 * See plans/2026-10-13_drill-25-coordinated-omission.md.
 */

const SLOW_EVERY = Number(__ENV.SLOW_EVERY || '50');
const SLOW_ORG = __ENV.SLOW_ORG || '1';
const SLOW_PATH = __ENV.SLOW_PATH || '/conversations?page=10000&pageSize=20';
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '60s';

// A request that never succeeded, as a duration. Printed as `never`; any mean that includes it is meaningless.
const NEVER = 1e9;
const WINDOW_S = 10;
const WINDOWS = Math.ceil(seconds(DURATION) / WINDOW_S);

const FAST_URL = `${BASE_URL}/conversations?page=${PAGE}&pageSize=${PAGE_SIZE}`;
const SLOW_URL = `${BASE_URL}${SLOW_PATH}`;

const timeToSuccess = new Trend('time_to_success', true);

const measured = (tags = '', metric = 'http_req_duration') =>
  `${metric}{scenario:measure${tags}}`;
const SLICES = SLOW_EVERY > 0 ? ['fast', 'slow'] : ['fast'];

export const options = scenario({
  thresholds: {
    // Overload is the subject, so errors report rather than abort the run.
    [measured('', 'http_req_failed')]: ['rate<=1'],
    // Declarations: k6 computes a tagged sub-metric only when a threshold names it.
    [measured(',expected_response:true')]: ['max>=0'],
    [measured('', 'time_to_success')]: ['max>=0'],
    ...Object.fromEntries(
      SLICES.map((ep) => [measured(`,ep:${ep}`), ['max>=0']]),
    ),
    ...Object.fromEntries(
      Array.from({ length: WINDOWS }, (_, w) => [
        measured(`,w:${w}`),
        ['max>=0'],
      ]),
    ),
  },
});

export default function (): void {
  const slow =
    SLOW_EVERY > 0 && exec.scenario.iterationInTest % SLOW_EVERY === 0;
  const ep = slow ? 'slow' : 'fast';
  // The window the request STARTED in, so a queue shows up where it formed.
  const w = Math.floor(
    (Date.now() - exec.scenario.startTime) / (WINDOW_S * 1000),
  );

  const res = http.get(slow ? SLOW_URL : FAST_URL, {
    headers: { 'x-org-id': slow ? SLOW_ORG : ORG_ID },
    tags: { ep, w: String(w) },
    timeout: REQ_TIMEOUT,
  });
  const ok = check(res, { 'status is 200': (r) => r.status === 200 });
  timeToSuccess.add(ok ? res.timings.duration : NEVER, { ep });
}

export function handleSummary(data: SummaryData) {
  const values = (name: string): Record<string, number> =>
    data.metrics[name]?.values ?? {};
  const ms = (x: number | undefined) =>
    x === undefined || Number.isNaN(x)
      ? 'n/a'
      : x >= NEVER
        ? 'never'
        : x.toFixed(2);

  const all = values(measured());
  const ok = values(measured(',expected_response:true'));
  const tts = values(measured('', 'time_to_success'));
  // At exactly 1% failed, k6 interpolates p99 between a real sample and NEVER. Above the real max is never.
  if (tts['p(99)'] > (all.max ?? 0)) tts['p(99)'] = NEVER;
  const failed = values(measured('', 'http_req_failed')).passes ?? 0;
  const dropped = values('dropped_iterations{scenario:measure}').count ?? 0;
  const count = all.count ?? 0;
  const offered = count + dropped;
  const never = failed + dropped;

  const slice = (ep: string) => {
    const s = values(measured(`,ep:${ep}`));
    const share = count ? ((s.count ?? 0) / count) * 100 : 0;
    return `${ep} ${share.toFixed(1)}% p50 ${ms(s.med)} p99 ${ms(s['p(99)'])}`;
  };
  const windows = Array.from({ length: WINDOWS }, (_, w) =>
    values(measured(`,w:${w}`)),
  );

  return summary(data, {
    params:
      `model=${MODEL} fast=org${ORG_ID}:page${PAGE} ` +
      `slow=org${SLOW_ORG}:${SLOW_PATH} every=${SLOW_EVERY} timeout=${REQ_TIMEOUT}`,
    columns: [
      MODEL,
      PAGE,
      SLOW_EVERY,
      REQ_TIMEOUT,
      ms(all.avg),
      ms(ok['p(99)']),
      ms(tts['p(99)']),
      failed,
      dropped,
    ],
    extra: [
      `  slices            : ${SLICES.map(slice).join(' · ')} ms`,
      `  mean vs p99       : mean ${ms(all.avg)} · p99 ${ms(all['p(99)'])} ms (p99 = ${((all['p(99)'] ?? 0) / (all.avg || 1)).toFixed(1)}× the mean)`,
      `  p99 by population : successes only ${ms(ok['p(99)'])} · every answer ${ms(all['p(99)'])} · time to success ${ms(tts['p(99)'])} ms`,
      `  never answered    : ${failed} failed + ${dropped} dropped of ${offered} offered (${((never / (offered || 1)) * 100).toFixed(2)}%)`,
      `  p99 per ${WINDOW_S}s       : ${windows.map((s) => ms(s['p(99)'])).join(' · ')} ms`,
      `  requests per ${WINDOW_S}s  : ${windows.map((s) => s.count ?? 0).join(' · ')}`,
    ],
  });
}
