import { headers } from 'next/headers';
import { REQUEST_ID_HEADER, deriveRequestId } from './request-id';

/**
 * The id proxy.ts put on this request, read back inside the render.
 *
 * proxy.ts sets it via `NextResponse.next({ request: { headers } })`, which is
 * what makes it visible to `headers()` here — the other form,
 * `next({ headers })`, sets response headers for the client instead.
 *
 * The fallback is not decoration: `headers()` opts a route into dynamic
 * rendering, and anything the proxy's matcher misses would otherwise have no
 * id at all. A generated one keeps the log line well-formed; it just will not
 * join up with anything, which is the honest outcome.
 */
export async function getRequestId(): Promise<string> {
  return deriveRequestId((await headers()).get(REQUEST_ID_HEADER));
}
