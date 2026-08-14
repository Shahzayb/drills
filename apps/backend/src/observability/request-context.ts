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
}

const storage = new AsyncLocalStorage<RequestContext>();

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
