import { NextResponse, type NextRequest } from 'next/server';
import { REQUEST_ID_HEADER, deriveRequestId } from '@/lib/request-id';

export function proxy(request: NextRequest) {
  const requestId = deriveRequestId(request.headers.get(REQUEST_ID_HEADER));

  const forwarded = new Headers(request.headers);
  forwarded.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
