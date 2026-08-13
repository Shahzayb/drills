import { NextResponse, type NextRequest } from 'next/server';
import { REQUEST_ID_HEADER, deriveRequestId } from '@/lib/request-id';

/**
 * The edge: every request either arrives with an id or leaves with one.
 *
 * `proxy.ts`, not `middleware.ts` — Next 16 renamed the convention and the
 * exported function, and it now defaults to the Node runtime.
 */
export function proxy(request: NextRequest) {
  const requestId = deriveRequestId(request.headers.get(REQUEST_ID_HEADER));

  // Two channels, and mixing them up is the classic mistake:
  // next({ request: { headers } }) is what the *app* sees (and how headers()
  // reaches it in a Server Component); response.headers is what the browser sees.
  const forwarded = new Headers(request.headers);
  forwarded.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // Without a matcher this runs for static assets too, and an id minted for
  // favicon.ico is an id that means nothing.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
