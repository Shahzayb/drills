import { fetchConversations } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const get = (key: string) => params.get(key) ?? undefined;

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
