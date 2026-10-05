import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { QUERY_COUNTER_MODE } from './query-counter';
import { currentTraceId } from './trace';

export const REQUEST_ID_HEADER = 'x-request-id';
// Card 18. When this response was produced, to the millisecond. A cache in
// front of the API hands the same response back later, and "served before it
// was asked for" is how the web tier tells a cache hit from a fresh answer.
export const SERVED_AT_HEADER = 'x-served-at';

// A security boundary, not tidiness: this value is interpolated into a SQL
// comment, so `*/ SELECT 1; --` would break out of it. Anything outside the set
// is replaced, not escaped. See the plan file.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface RequestContext {
  requestId: string;
  // Statements sent through PostgresService.query() — what card 08's "≤3"
  // budget counts, and what x-query-count reports. Mutated in place rather
  // than reassigned, because the store this interface describes is one object
  // held for the life of the request.
  queries: number;
  // Every round trip on the connection: queries above, plus BEGIN /
  // set_config / COMMIT, which TenantDb.withOrg issues through
  // ClientHandle.control() and which is not a "query" in the budget's sense.
  // Drill 07 priced that wrapper at ~0.94ms/request; this is what would have
  // shown it without re-deriving the number. See
  // plans/2026-08-17_drill-08-n-plus-one.md.
  roundTrips: number;
  // Transactions this request restarted after a serialization failure (40001)
  // or a deadlock (40P01). Card 13: on QUOTA=serializable this is the retry
  // rate, per request, without a second instrument — and it is why a retried
  // request legitimately breaches its @QueryBudget. See
  // plans/2026-09-07_drill-13-lost-update.md.
  retries: number;
  // Card 22. Time this request spent waiting for a pool connection, and holding
  // one. Summed over every acquire. See plans/2026-10-06_drill-22-connection-pool-knee.md.
  poolWaitMs: number;
  poolHoldMs: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The store for the request being served, or undefined outside one. Exists
 *  so LoggingInterceptor can read the final counts without importing the ALS
 *  instance itself. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Whether the two recorders below do anything. `QUERY_COUNTER=off` has to skip
 * the increments themselves, not just the reporting — otherwise the `off` arm
 * prices the LoggingInterceptor's tap and nothing else, while every statement
 * still pays an AsyncLocalStorage lookup, and the number it produces answers a
 * question nobody asked. Read once at module load, same as the mode itself.
 */
const COUNTING_ENABLED = QUERY_COUNTER_MODE !== 'off';

/** Called once per statement PostgresService.runOn() issues, success or
 *  failure — a query that errored still made the round trip. */
export function recordQuery(): void {
  if (!COUNTING_ENABLED) return;
  const store = storage.getStore();
  if (store) {
    store.queries += 1;
    store.roundTrips += 1;
  }
}

/** Called once per ClientHandle.control() call (BEGIN / set_config / COMMIT /
 *  ROLLBACK) — a real round trip, deliberately not counted as a query. */
export function recordRoundTrip(): void {
  if (!COUNTING_ENABLED) return;
  const store = storage.getStore();
  if (store) store.roundTrips += 1;
}

/** Called once per transaction restart in TenantDb.withOrg. Deliberately NOT
 *  gated on COUNTING_ENABLED: a retry is a correctness event, not a
 *  measurement, and `QUERY_COUNTER=off` must not hide one. */
export function recordRetry(): void {
  const store = storage.getStore();
  if (store) store.retries += 1;
}

// Seconds, Prometheus-style cumulative buckets: from an idle connection handed
// over at once to the 2s acquire timeout.
const POOL_BUCKETS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

const histogram = (): Histogram => ({
  buckets: POOL_BUCKETS.map(() => 0),
  sum: 0,
  count: 0,
});

// Process-wide, always on: unlike the per-request sums, these are the shipped
// metric, so QUERY_COUNTER=off does not hide them.
const poolWait = histogram();
const poolHold = histogram();
const poolErrors = { timeout: 0, connect: 0 };

function observe(h: Histogram, ms: number): void {
  const s = ms / 1000;
  h.sum += s;
  h.count += 1;
  for (let i = 0; i < POOL_BUCKETS.length; i++) {
    if (s <= POOL_BUCKETS[i]) h.buckets[i] += 1;
  }
}

/** Called once per pool acquire, with how long `pool.connect()` took. Card 22. */
export function recordPoolWait(ms: number): void {
  observe(poolWait, ms);
  if (!COUNTING_ENABLED) return;
  const store = storage.getStore();
  if (store) store.poolWaitMs += ms;
}

/** Called once per release, with how long the connection was held. */
export function recordPoolHold(ms: number): void {
  observe(poolHold, ms);
  if (!COUNTING_ENABLED) return;
  const store = storage.getStore();
  if (store) store.poolHoldMs += ms;
}

/** An acquire that failed: pg-pool's queue timeout, or a refused new connection. */
export function recordPoolError(reason: keyof typeof poolErrors): void {
  poolErrors[reason] += 1;
}

const renderHistogram = (name: string, help: string, h: Histogram) => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} histogram`,
  ...POOL_BUCKETS.map((le, i) => `${name}_bucket{le="${le}"} ${h.buckets[i]}`),
  `${name}_bucket{le="+Inf"} ${h.count}`,
  `${name}_sum ${h.sum}`,
  `${name}_count ${h.count}`,
];

/** Card 22's lines on GET /metrics. Lives here because ESLint keeps postgres.service out of controllers. */
export function poolMetrics(): string {
  return [
    ...renderHistogram(
      'pg_pool_acquire_wait_seconds',
      'Time from asking the pool for a connection to holding one.',
      poolWait,
    ),
    ...renderHistogram(
      'pg_pool_hold_seconds',
      'Time a connection was checked out, acquire to release.',
      poolHold,
    ),
    '# HELP pg_pool_acquire_errors_total Acquires that failed: queue timeout or a refused connection.',
    '# TYPE pg_pool_acquire_errors_total counter',
    ...Object.entries(poolErrors).map(
      ([reason, n]) => `pg_pool_acquire_errors_total{reason="${reason}"} ${n}`,
    ),
    '',
  ].join('\n');
}

/**
 * Accept the caller's id only if it is safe to embed; otherwise mint one.
 *
 * With tracing on, "mint one" is the 32-hex trace id rather than a UUID, so one
 * string greps the logs and pastes into Jaeger. Both fallbacks satisfy the
 * allowlist by construction — see currentTraceId. A caller-supplied id still
 * wins; that is opting out of the join, and `trace_id` on every line is the way
 * back. Next's proxy cannot do this, and why is in the plan file.
 */
export function deriveRequestId(raw: unknown): string {
  if (typeof raw === 'string' && SAFE_REQUEST_ID.test(raw)) return raw;
  return currentTraceId() ?? randomUUID();
}

// Memoised on the request object. nestjs-pino's genReqId and our middleware
// both need this value; Nest orders global-module middleware first, so pino
// happens to derive it, but neither depends on that. Symbol.for, not Symbol, so
// two copies of this module could not silently keep separate memos.
const REQUEST_ID = Symbol.for('drills.requestId');

type Carrier = IncomingMessage & { [REQUEST_ID]?: string };

export function requestIdFor(req: IncomingMessage): string {
  const carrier = req as Carrier;
  carrier[REQUEST_ID] ??= deriveRequestId(req.headers[REQUEST_ID_HEADER]);
  return carrier[REQUEST_ID];
}

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

/**
 * The id of the request being served, or undefined outside one (bootstrap,
 * shutdown, the seed scripts). Exists so PostgresService can reach the id
 * without every signature between it and the controller growing a parameter.
 */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
