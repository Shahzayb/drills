import { cacheArm, tagsAfterWrite } from '@/lib/api';
import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Expire what a write to one conversation makes wrong. Card 18.
 *
 * The webhook shape, and the reason it exists: a write that does not go
 * through a Server Action — `PATCH /conversations/:id` from curl, from k6,
 * from a Playwright fixture, from `POST /ingest` — changes the database and
 * tells Next nothing. Revalidation is only as complete as the set of write
 * paths that call it, and this is the door for the ones outside the app.
 *
 * `revalidateTag(tag, { expire: 0 })`, not `updateTag`: the second is for
 * Server Actions only (it throws here), and `{ expire: 0 }` is the same
 * immediate expiry rather than `'max'`'s stale-while-revalidate. Same tag
 * decision as the actions, through the same function.
 *
 * Unauthenticated, like everything else that writes in this repo. Anyone who
 * can reach it can empty an org's cache — named in the drill's honest gaps.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    org?: string;
    id?: string;
    cache?: string;
  };
  const orgId = String(body.org ?? '');
  const id = String(body.id ?? '');
  if (!orgId || !id) {
    return NextResponse.json(
      { error: 'org and id are required' },
      { status: 400 },
    );
  }

  const expired = tagsAfterWrite(cacheArm(String(body.cache ?? '')), {
    orgId,
    id,
  });
  for (const tag of expired) revalidateTag(tag, { expire: 0 });

  return NextResponse.json({ expired, now: new Date().toISOString() });
}
