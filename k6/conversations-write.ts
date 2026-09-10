import {
  API_KEY,
  BASE_URL,
  RATE,
  post,
  scenario,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

/**
 * Drill 16 — POST /ingest at a steady arrival rate, while a migration runs.
 *
 * The first script here that measures OFFERED load rather than concurrency, and
 * that is the whole reason it exists rather than being a knob on
 * ingest-storm.ts. A closed-model run (constant-vus, every other script in this
 * directory) cannot show a lock outage honestly: ten VUs blocked behind an
 * ACCESS EXCLUSIVE lock simply stop sending, throughput falls to zero, and the
 * summary reports ten very slow requests. Nothing says that a real service
 * would have received four thousand more in the same window.
 *
 * constant-arrival-rate keeps offering RATE requests a second regardless. When
 * every allocated VU is parked on a blocked request the executor cannot start
 * the next iteration and records a dropped one, and THAT number — printed by
 * lib/scenario.ts' summary — is the outage. The latency percentiles only
 * describe requests that happened.
 *
 * Distinct event ids, not a duplicate storm. ingest-storm.ts is the storm and
 * this is not: every iteration is a new conversation, so every request is a
 * real write against the table the migration is locking. `% 0` never happens
 * because the ring is the run itself.
 *
 * Three runs make the card's result set, in one sitting, on a settled database:
 *
 *   pnpm db:storm key --org 1
 *   pnpm load write --name baseline      --api-key dk_...
 *   pnpm load write --name naive-during  --api-key dk_...   # + pnpm db:schema naive
 *   pnpm load write --name safe-during   --api-key dk_...   # + pnpm db:schema safe
 *
 * WATCH OUT: this writes real rows and has no cleanup of its own, because k6
 * has no database connection. The prefix is `k6-`, the same one
 * memory-bank/progress.md's cleanup query already names:
 *
 *   DELETE FROM conversations
 *    WHERE org_id = 1 AND provider_event_id IS NOT NULL
 *      AND provider_event_id LIKE 'k6-%';
 */

const RUN = `k6-${__ENV.NAME || 'write'}`;

export const options = scenario({
  measure: {
    executor: 'constant-arrival-rate',
    rate: RATE,
    timeUnit: '1s',
    duration: __ENV.DURATION || '60s',
    // Enough headroom that the rate is met comfortably when nothing is wrong,
    // and a hard ceiling on how much a stalled server can absorb before the
    // executor starts dropping. At 200 VUs and a 90s lock, everything after the
    // first four seconds of the outage is a dropped iteration — which is the
    // measurement, not a limitation of it.
    preAllocatedVUs: 50,
    maxVUs: 200,
  },
  thresholds: {
    // A migration run is EXPECTED to produce errors on the naive arm, so the
    // baseline's rate<0.01 is replaced rather than added to. The comparison is
    // the recorded number, not a pass/fail gate.
    'http_req_failed{scenario:measure}': ['rate<=1'],
  },
});

export default function (): void {
  // Unique per (VU, iteration) for the life of the run. Two runs with the same
  // NAME collide, and drill 12's partial unique index turns that into a
  // duplicate rather than a second row — so the NAME is what keeps a re-run
  // measuring inserts.
  const n = __VU * 1_000_000 + __ITER;
  post(
    `${BASE_URL}/ingest`,
    { eventId: `${RUN}-${String(n).padStart(9, '0')}`, message: `k6 write ${n}` },
    { Authorization: `Bearer ${API_KEY}` },
  );
}

export function handleSummary(data: SummaryData) {
  return summary(data, {
    params: `prefix=${RUN}`,
    columns: [RATE, RUN],
  });
}
