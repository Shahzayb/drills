import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

// A security boundary, not tidiness: this value is interpolated into a SQL
// comment, so `*/ SELECT 1; --` would break out of it. Anything outside the set
// is replaced, not escaped. See the plan file.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Accept the caller's id only if it is safe to embed; otherwise mint one. */
export function deriveRequestId(raw: unknown): string {
  return typeof raw === 'string' && SAFE_REQUEST_ID.test(raw)
    ? raw
    : randomUUID();
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
