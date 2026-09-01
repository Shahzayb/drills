import {
  API_KEY,
  BASE_URL,
  UNIQUE,
  post,
  scenario,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

/**
 * Drill 12 — POST /ingest under sustained concurrency.
 *
 * `pnpm db:storm fire` is the correctness proof: it counts rows and asserts.
 * This is the latency half, and it is a separate instrument for the reason
 * db/paging.mts gives about EXPLAIN — the two answer different questions. The
 * storm asks "did the mechanism hold"; this asks "what does it cost per
 * request, sustained, with the warm-up thrown away and a p99 that is comparable
 * to every other number in k6/reports/".
 *
 * Which arm answers is not set here. It is `IDEMPOTENCY` on the *server*, so an
 * A/B is two runs with a `docker compose up -d nest_server` between them:
 *
 *   pnpm db:storm key --org 1
 *   IDEMPOTENCY=constraint docker compose up -d nest_server
 *   pnpm load ingest --name constraint --api-key dk_...
 *   docker compose up -d nest_server
 *   pnpm load ingest --name both --api-key dk_...
 *
 * The event id is derived from the iteration rather than randomised, so the
 * duplicate ratio is a property of the run and not of luck. Every VU walks the
 * same UNIQUE-sized ring, which means VUs collide with each other constantly —
 * that is the storm, and it is what makes this different from a write benchmark.
 *
 * WATCH OUT: this writes real rows. It has no cleanup of its own, because k6
 * has no database connection — the prefix is printed in the summary and
 * `pnpm db:storm fire` is the one that tidies up after itself. Delete them
 * before running any drill 05/09/10 baseline, or the whale's inbox has a few
 * thousand rows with a fresh updated_at at the top of it.
 */

// __VU and __ITER are k6 globals. Together they make the id deterministic per
// (vu, iteration), and `% UNIQUE` is what turns a stream of distinct events
// into a storm with a known duplicate ratio.
const RUN = `k6-${__ENV.NAME || 'run'}`;

export const options = scenario();

export default function (): void {
  const n = (__VU * 100_000 + __ITER) % UNIQUE;
  post(
    `${BASE_URL}/ingest`,
    {
      eventId: `${RUN}-${String(n).padStart(6, '0')}`,
      message: `k6 delivery ${n}`,
    },
    { Authorization: `Bearer ${API_KEY}` },
  );
}

export function handleSummary(data: SummaryData) {
  return summary(data, {
    params: `unique=${UNIQUE} prefix=${RUN}`,
    columns: [UNIQUE, RUN],
  });
}
