export const REQUEST_ID_HEADER = 'x-request-id';

// Duplicated from apps/backend/src/observability/request-context.ts rather than
// shared through packages/, which would need build wiring neither app has. The
// allowlist is a security boundary: on the API side this value is interpolated
// into a SQL comment. See the plan file.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Accept the caller's id if it is safe to pass on, otherwise mint one.
 *
 * No Next imports here: proxy.ts imports this, and pulling `next/headers` into
 * the proxy bundle is not something to discover at runtime.
 */
export function deriveRequestId(raw: string | null | undefined): string {
  return raw && SAFE_REQUEST_ID.test(raw) ? raw : crypto.randomUUID();
}
