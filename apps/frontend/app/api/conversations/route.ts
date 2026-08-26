import { fetchConversations } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';

/**
 * The browser's only way to reach the API.
 *
 * `BACKEND_INTERNAL_URL` is a Compose service name, which resolves on the
 * Compose network and nowhere else — a client component cannot fetch it, and
 * publishing the backend's port to make it possible would move tenant identity
 * into the browser's hands. So the load-more button talks to Next, and Next
 * talks to Nest.
 *
 * It is a thin pass-through on purpose: `fetchConversations` is where the org
 * header, the `x-request-id` and the W3C `traceparent` get attached, so
 * everything drill 06 built still works for a request the browser started. A
 * hand-rolled fetch here would silently drop all three.
 *
 * A GET, not a Server Function. Server Functions are POSTs and are meant for
 * mutations; this is a read, and keeping it a GET leaves it cacheable by
 * whatever comes next.
 *
 * See plans/2026-08-26_drill-10-keyset-pagination.md.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const get = (key: string) => params.get(key) ?? undefined;

  // Nothing is validated here, same rule as the page: the API owns those rules
  // and a second copy of them is a second copy to keep in sync. A bad cursor
  // comes back as the API's own 400, with the message that says which rule it
  // broke.
  const result = await fetchConversations({
    orgId: get('org') ?? '1',
    page: get('page') ?? '1',
    pageSize: get('pageSize') ?? '50',
    sort: get('sort') ?? 'updated_at',
    status: get('status'),
    updatedFrom: get('updatedFrom'),
    updatedTo: get('updatedTo'),
    paging: 'keyset',
    cursor: get('cursor'),
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 502 },
    );
  }

  return NextResponse.json(result.page);
}
