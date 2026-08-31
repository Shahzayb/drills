import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { QUERY_COUNTER_MODE } from './query-counter';
import { currentTraceId } from './trace';

export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface RequestContext {
  requestId: string;
  queries: number;
  roundTrips: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

const COUNTING_ENABLED = QUERY_COUNTER_MODE !== 'off';

export function recordQuery(): void {
  if (!COUNTING_ENABLED) return;
  const store = storage.getStore();
  if (store) {
    store.queries += 1;
    store.roundTrips += 1;
  }
}

export function recordRoundTrip(): void {
  if (!COUNTING_ENABLED) return;
  const store = storage.getStore();
  if (store) store.roundTrips += 1;
}

export function deriveRequestId(raw: unknown): string {
  if (typeof raw === 'string' && SAFE_REQUEST_ID.test(raw)) return raw;
  return currentTraceId() ?? randomUUID();
}

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

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
