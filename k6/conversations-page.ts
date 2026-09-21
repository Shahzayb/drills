import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import {
  BASE_URL,
  DURATION,
  ORG_ID,
  PAGE_SIZE,
  WARMUP,
  scenario,
  seconds,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

/**
 * Drill 18 — the inbox page through NEXT, one ?cache= arm at a time.
 *
 * Every other script here hits the API. This one hits the web tier, because
 * the thing under test is Next's data cache and the API never sees a hit. The
 * page is the whale's inbox with the stats widget streaming, so a cache miss
 * is one 5GB scan and a hit is none — the arms are measured by what the API
 * was asked to do, not only by how fast the page came back.
 *
 * Three scenarios. `warmup` and `measure` are lib/scenario.ts's, unchanged.
 * `mutate` runs alongside both and, every MUTATE_EVERY seconds, changes one
 * row's status through the API and tells Next about it through
 * `/api/revalidate` with the arm's tag choice — a write, the same shape the
 * UI's Server Action makes. That is the whole comparison: what one write per
 * five seconds costs the readers, per arm.
 *
 *   nostore   every view runs the API: list, agents, and the scan
 *   tagged    a write expires the row and the org's lists; the scan never
 *   blanket   a write expires the org; every write is followed by a scan
 *   cached    nothing expires; the floor, and every view is stale
 *
 * The page's own footer says who answered each fetch (`data-served`), so the
 * counters below are read off the HTML rather than inferred from latency.
 *
 *   pnpm load page --cache nostore --name nostore
 *   pnpm load page --cache tagged  --name tagged
 *   pnpm load page --cache blanket --name blanket
 *
 * Against the production build (`pnpm docker:up:prod`): dev's cache lives in
 * memory plus `.next/dev/cache` and dev renders are not what ships.
 */

const CACHE = __ENV.CACHE || 'tagged';
const MUTATE_EVERY = Number(__ENV.MUTATE_EVERY || '5');
const WEB_URL = __ENV.WEB_URL || 'http://next_app:3001';

const page = `${WEB_URL}/conversations?org=${ORG_ID}&pageSize=${PAGE_SIZE}&stats=stream&cache=${CACHE}`;

// One counter per (fetch, answer). Tagged sub-metrics would need a threshold
// each to exist in handleSummary; six plain counters need nothing.
const FETCHES = ['list', 'agents', 'stats'] as const;
const ANSWERS = ['origin', 'cache'] as const;
const served: Record<string, Counter> = {};
for (const f of FETCHES)
  for (const a of ANSWERS)
    served[`${f}_${a}`] = new Counter(`served_${f}_${a}`);
const mutations = new Counter('mutations');

const base = scenario();
export const options = {
  ...base,
  scenarios: {
    ...base.scenarios,
    // Runs for the whole run, warm-up included, so the cache is in the same
    // regime throughout the measured window rather than settling into it.
    ...(MUTATE_EVERY > 0
      ? {
          mutate: {
            executor: 'constant-arrival-rate',
            rate: 1,
            timeUnit: `${MUTATE_EVERY}s`,
            duration: `${seconds(WARMUP) + seconds(DURATION)}s`,
            preAllocatedVUs: 1,
            maxVUs: 2,
            exec: 'mutate',
          },
        }
      : {}),
  },
};

/** The row the mutate scenario flips. k6 has no database, so it is the API's
 *  newest row for the org — and flipping it moves it to the top of page 1,
 *  which is the page the readers are loading. */
export function setup(): { id: string } {
  const res = http.get(
    `${BASE_URL}/conversations?paging=keyset&pageSize=1&sort=updated_at`,
    { headers: { 'x-org-id': ORG_ID } },
  );
  const body = res.json() as { items: { id: string }[] };
  return { id: body.items[0].id };
}

export default function (): void {
  const res = http.get(page);
  check(res, { 'status is 200': (r) => r.status === 200 });
  if (exec.scenario.name !== 'measure' || res.status !== 200) return;

  const html = res.body as string;
  for (const f of FETCHES) {
    const m = html.match(
      new RegExp(`data-fetch="${f}" data-served="(origin|cache)"`),
    );
    if (m) served[`${f}_${m[1]}`].add(1);
  }
}

export function mutate(data: { id: string }): void {
  const status = __ITER % 2 === 0 ? 'closed' : 'open';
  const patched = http.patch(
    `${BASE_URL}/conversations/${data.id}`,
    JSON.stringify({ status }),
    { headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' } },
  );
  const told = http.post(
    `${WEB_URL}/api/revalidate`,
    JSON.stringify({ org: ORG_ID, id: data.id, cache: CACHE }),
    { headers: { 'content-type': 'application/json' } },
  );
  check(patched, { 'write is 200': (r) => r.status === 200 });
  check(told, { 'revalidate is 200': (r) => r.status === 200 });
  mutations.add(1);
  sleep(0);
}

export function handleSummary(data: SummaryData) {
  const count = (name: string) => data.metrics[name]?.values.count ?? 0;
  const views = data.metrics['http_reqs{scenario:measure}'].values.count;
  const per100 = (name: string) =>
    views ? ((100 * count(name)) / views).toFixed(1) : '0.0';

  return summary(data, {
    params: `cache=${CACHE} mutate_every=${MUTATE_EVERY}s`,
    columns: [CACHE, MUTATE_EVERY, PAGE_SIZE],
    extra: [
      `  origin / 100 views: list ${per100('served_list_origin')} · agents ${per100('served_agents_origin')} · stats ${per100('served_stats_origin')}`,
      `  stats             : ${count('served_stats_origin')} scans · ${count('served_stats_cache')} cache answers · ${views - count('served_stats_origin') - count('served_stats_cache')} views without a widget, in ${views} views`,
      `  writes            : ${count('mutations')} (status flip + /api/revalidate, cache=${CACHE})`,
    ],
  });
}
