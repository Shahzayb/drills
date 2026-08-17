import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { currentTraceId } from './trace';

export const REQUEST_ID_HEADER = 'x-request-id';

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
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The store for the request being served, or undefined outside one. Exists
 *  so LoggingInterceptor can read the final counts without importing the ALS
 *  instance itself. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Called once per statement PostgresService.runOn() issues, success or
 *  failure — a query that errored still made the round trip. */
export function recordQuery(): void {
  const store = storage.getStore();
  if (store) {
    store.queries += 1;
    store.roundTrips += 1;
  }
}

/** Called once per ClientHandle.control() call (BEGIN / set_config / COMMIT /
 *  ROLLBACK) — a real round trip, deliberately not counted as a query. */
export function recordRoundTrip(): void {
  const store = storage.getStore();
  if (store) store.roundTrips += 1;
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
