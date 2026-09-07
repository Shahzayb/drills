'use server';

import { assignConversation, type ConflictState } from '@/lib/api';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { refresh } from 'next/cache';

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
 * **What revalidates: `refresh()`, and nothing else.**
 *
 * `revalidatePath('/conversations')` would be both wider and less effective.
 * The page's data is an uncached `fetch` to Nest — Next 16 does not cache fetch
 * by default — so there is no cache entry for it to invalidate, and it
 * currently also marks every previously visited page for refresh on the next
 * navigation. `revalidateTag` needs tags this app does not have, and its
 * stale-while-revalidate profile deliberately skips the immediate re-render,
 * which is exactly the re-render the losing client needs.
 *
 * `refresh()` refetches the current route's RSC payload and stops there. Next
 * puts it in the SAME response as this function's return value, so the true row
 * and the explanation of why the optimistic one was wrong arrive together, in
 * one roundtrip, as a soft update. No reload, no `router.refresh()` from the
 * client, no follow-up fetch anyone had to write.
 *
 * It is called on the CONFLICT path too, and that is the load-bearing half. The
 * 409 body already carries `current`, so the UI could repaint the row from it —
 * and would then be trusting a payload instead of the server. The message comes
 * from the response; the row comes from a render.
 *
 * See plans/2026-09-08_drill-14-optimistic-locking.md.
 */
export async function claimConversation(input: {
  id: string;
  orgId: string;
  assigneeId: string | null;
  version: number;
}): Promise<
  | { ok: true }
  | { ok: false; message: string; status: number; current?: ConflictState }
> {
  const result = await assignConversation(input);
  const rid = await getRequestId();

  if (result.ok) {
    logger.info(
      {
        rid,
        route: '/conversations',
        conversationId: input.id,
        outcome: 'claimed',
      },
      'assign_action',
    );
    refresh();
    return { ok: true };
  }

  logger.info(
    {
      rid,
      route: '/conversations',
      conversationId: input.id,
      outcome: 'refused',
      status: result.status,
    },
    'assign_action',
  );

  // Refreshed on the way out even though the write failed: the row on screen is
  // wrong either way — the optimistic update already changed it — and the only
  // thing that can make it right is a render from the server.
  refresh();

  return {
    ok: false,
    status: result.status,
    message: result.message,
    current: result.current,
  };
}
