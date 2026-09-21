'use server';

import {
  assignConversation,
  cacheArm,
  tagsAfterWrite,
  updateConversationStatus,
  type CacheArm,
  type ConflictState,
} from '@/lib/api';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { refresh, updateTag } from 'next/cache';

/**
 * What a write does to the cache, per arm. Card 18.
 *
 * `updateTag`, not `revalidateTag(tag, 'max')`: the second is
 * stale-while-revalidate and Next deliberately does NOT re-render the action's
 * own response for it ("so that server actions don't pull their own writes",
 * `server/web/spec-extension/revalidate.js`). The user who clicked must read
 * their own write, so the entry is expired, not marked.
 *
 * `refresh()` only when nothing was tagged — and never after `updateTag`. Both
 * set the same flag Next reads to decide what the client does with the
 * response: `updateTag` marks it StaticAndDynamic (evict the client's cache,
 * re-render), `refresh()` marks it DynamicOnly (re-render, keep the cache), and
 * the LAST call wins. A `refresh()` after an `updateTag()` would quietly
 * downgrade the fix. Order is the whole function.
 */
function expireAfterWrite(
  arm: CacheArm,
  target: { orgId: string; id: string },
): string[] {
  const expired = tagsAfterWrite(arm, target);
  if (expired.length === 0) refresh();
  for (const tag of expired) updateTag(tag);
  return expired;
}

/**
 * The claim, as a Server Action. Card 14.
 *
 * `'use server'` at the top of the FILE, not inside the function. A Client
 * Component cannot define a Server Function, and this one is called from
 * `conversation-list.tsx` — a file-level directive is what lets it be imported
 * there and swapped for an action reference in the client bundle.
 *
 * **This is a public POST endpoint.** The directive compiles the body away from
 * the browser, but the route it leaves behind is reachable by anyone who can
 * send the same request, with or without the UI. It authenticates nothing —
 * `orgId` and `assigneeId` arrive from the client, exactly like `?org=` and
 * `?me=` in the URL. That is the same recorded stub the rest of this repo runs
 * on rather than a hole introduced here, and it is named in the drill's honest
 * gaps rather than left for a reader to notice.
 *
 * **What revalidates.** Before card 18 this was `refresh()` and nothing else:
 * the page's data was an uncached `fetch`, so there was no cache entry to
 * expire, and `revalidatePath` would have marked every previously visited page
 * for refresh while invalidating nothing. Card 18 cached the fetch, so now a
 * claim expires the row's tag and the org's list tag through
 * `expireAfterWrite` — and `refresh()` alone is exactly the arm (`cached`)
 * that reproduces the stale read.
 *
 * `refresh()` refetches the current route's RSC payload and stops there. Next
 * puts it in the SAME response as this function's return value, so the true
 * row and the explanation of why the optimistic one was wrong arrive together,
 * in one roundtrip, as a soft update. No reload, no `router.refresh()` from
 * the client, no follow-up fetch anyone had to write. `updateTag` rides the
 * same response.
 *
 * It is called on the CONFLICT path too, and that is the load-bearing half. The
 * 409 body already carries `current`, so the UI could repaint the row from it —
 * and would then be trusting a payload instead of the server. The message comes
 * from the response; the row comes from a render — and on a cached arm that
 * render must miss, or the loser converges on a stale list.
 *
 * See plans/2026-09-08_drill-14-optimistic-locking.md and
 * plans/2026-09-21_drill-18-next-cache-layers.md.
 */
export async function claimConversation(input: {
  id: string;
  orgId: string;
  assigneeId: string | null;
  version: number;
  cache: string;
}): Promise<
  | { ok: true }
  | { ok: false; message: string; status: number; current?: ConflictState }
> {
  const result = await assignConversation(input);
  const rid = await getRequestId();
  const arm = cacheArm(input.cache);
  const target = { orgId: input.orgId, id: input.id };

  if (result.ok) {
    const expired = expireAfterWrite(arm, target);
    logger.info(
      {
        rid,
        route: '/conversations',
        conversationId: input.id,
        outcome: 'claimed',
        arm,
        expired,
      },
      'assign_action',
    );
    return { ok: true };
  }

  // Expired on the way out even though the write failed: the row on screen is
  // wrong either way — the optimistic update already changed it — and the only
  // thing that can make it right is a render from the server that misses.
  const expired = expireAfterWrite(arm, target);
  logger.info(
    {
      rid,
      route: '/conversations',
      conversationId: input.id,
      outcome: 'refused',
      status: result.status,
      arm,
      expired,
    },
    'assign_action',
  );

  return {
    ok: false,
    status: result.status,
    message: result.message,
    current: result.current,
  };
}

/**
 * The status change, as a Server Action bound to a plain <form>. Card 18.
 *
 * Takes FormData because the detail page is a Server Component and its form
 * has no JavaScript behind it: `<form action={setConversationStatus}>` posts
 * the fields with JS off and calls the action without a navigation with JS
 * on. Same public-POST caveat as the claim above — `org` and `cache` arrive
 * from the form, the same stub as `?org=`.
 *
 * Nothing is returned. The response IS the re-render: with `updateTag` the
 * detail page fetches again and misses, and the user reads their own write in
 * the same round trip. On the `cached` arm the re-render hits, and the page
 * they are looking at says `open` while the database says `closed`. That is
 * the bug, reproduced by the arm rather than by accident.
 */
export async function setConversationStatus(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const orgId = String(formData.get('org') ?? '');
  const status = String(formData.get('status') ?? '');
  const arm = cacheArm(String(formData.get('cache') ?? ''));
  const rid = await getRequestId();

  const result = await updateConversationStatus({ orgId, id, status });
  const expired = expireAfterWrite(arm, { orgId, id });

  logger.info(
    {
      rid,
      route: '/conversations/[id]',
      conversationId: id,
      outcome: result.ok ? 'updated' : 'refused',
      status: result.ok ? 200 : result.status,
      to: status,
      arm,
      expired,
    },
    'status_action',
  );
}
