'use client';

import type { Conversation } from '@/lib/api';
import { useOptimistic, useState, useTransition } from 'react';
import { claimConversation } from './actions';

/**
 * The table, the load-more button that appends to it, and the claim button that
 * lies for a moment.
 *
 * This is the first `"use client"` in the repo, and it spends a property drills
 * 03 and 09 both protected: `/conversations` used to ship **zero** application
 * JavaScript. That was worth keeping while the page was a document. A cursor is
 * not a document — "give me the next page and leave the ones I have alone" is
 * state, and a plain anchor cannot express it.
 *
 * What survives: the *first* page is still rendered on the server. A client
 * component is server-rendered too, so `curl` still returns every row of page 1
 * in the HTML. Only pages 2..n need the browser. And `?mode=offset` is a
 * complete, JavaScript-free path through the same data — see the <noscript> in
 * page.tsx.
 *
 * Card 14 adds the claim. See plans/2026-09-08_drill-14-optimistic-locking.md.
 */
export function ConversationList({
  initialItems,
  initialCursor,
  query,
  me,
  meName,
}: {
  /**
   * The server-rendered first page, and it is LIVE.
   *
   * Card 14 changed what this prop means. It used to seed `useState` once, which
   * was fine while nothing on the page could change a row: a re-render with new
   * data would have been ignored and there was never any new data. There is now
   * — `refresh()` in the Server Action re-renders this page — and a `useState`
   * seed would have swallowed exactly the update the drill exists to deliver.
   * The table reads this prop every render; only *appended* pages are state.
   */
  initialItems: Conversation[];
  /** Null when there is no next page — the API says so, we do not infer it. */
  initialCursor: string | null;
  /** The current org/sort/filter state, forwarded to the route handler so page
   *  2 is the same query as page 1. Without it the second page silently drops
   *  the active filter, which is the bug the page's linkTo() already guards. */
  query: Record<string, string>;
  /** The membership id claiming things, from `?me=`. Null when no agent is
   *  selected, and then there is nothing to assign to and no button. */
  me: string | null;
  meName: string | null;
}) {
  // Only the pages fetched by the browser. Page 1 comes from the prop above, so
  // a server re-render reaches the table.
  const [appended, setAppended] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the server said when it refused a claim, keyed by row. */
  const [conflicts, setConflicts] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  const rows = [...initialItems, ...appended];

  /**
   * The lie, and how long it lasts.
   *
   * `useOptimistic` renders this in place of `rows` for as long as the
   * transition below is pending. Nothing ever undoes it: when the transition
   * ends and the refreshed server render lands, `optimisticRows` simply goes
   * back to being `rows`. If the claim won, `rows` already says so and nothing
   * visibly changes. If it lost, the row snaps to whoever actually owns it.
   *
   * `pending` on the row is what makes the difference visible while it is still
   * in doubt — an optimistic update that is indistinguishable from a confirmed
   * one is the thing that makes a later correction feel like a bug.
   */
  const [optimisticRows, applyClaim] = useOptimistic(
    rows,
    (current: Conversation[], claim: { id: string; assigneeName: string }) =>
      current.map((row) =>
        row.id === claim.id
          ? { ...row, assigneeName: claim.assigneeName, pending: true }
          : row,
      ) as (Conversation & { pending?: boolean })[],
  );

  function claim(row: Conversation) {
    if (!me || !meName) return;

    startTransition(async () => {
      // Applies on THIS frame. A useState setter here would be deferred until
      // the transition finished, which would make the "optimistic" update
      // arrive at the same time as the real one — i.e. not optimistic at all.
      applyClaim({ id: row.id, assigneeName: meName });

      const result = await claimConversation({
        id: row.id,
        orgId: query.org,
        assigneeId: me,
        version: row.version,
      });

      // A useState setter, and being deferred is the point. React holds this
      // until the transition commits, so the message lands on the same paint as
      // the corrected row — the user never sees "you got it" and "you didn't"
      // in two different frames.
      setConflicts((current) =>
        result.ok
          ? { ...current, [row.id]: '' }
          : { ...current, [row.id]: result.message },
      );
    });
  }

  async function loadMore() {
    if (!cursor || loading) return;
    // Guarding on `loading` and disabling the button are not the same guard:
    // the disabled attribute is a UI hint, this is the one that stops a
    // double-click appending the same page twice.
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ ...query, cursor });
      const response = await fetch(`/api/conversations?${params}`);
      const body: unknown = await response.json();

      if (!response.ok) {
        const detail = (body as { error?: string }).error;
        throw new Error(detail ?? `request failed (${response.status})`);
      }

      const page = body as { items: Conversation[]; nextCursor: string | null };
      // Append, never replace: the whole point of the cursor is that the rows
      // already on screen do not move.
      setAppended((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-black/[.08] bg-white dark:border-white/[.145] dark:bg-zinc-950">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-black/[.08] text-xs text-zinc-500 dark:border-white/[.145] dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">id</th>
              <th className="px-4 py-3 font-medium">status</th>
              <th className="px-4 py-3 font-medium">assignee</th>
              <th className="px-4 py-3 font-medium">v</th>
              <th className="px-4 py-3 font-medium">tags</th>
              <th className="px-4 py-3 font-medium">updated_at</th>
            </tr>
          </thead>
          <tbody>
            {optimisticRows.map((conversation) => {
              const pending = (conversation as { pending?: boolean }).pending;
              const conflict = conflicts[conversation.id];
              return (
                <tr
                  key={conversation.id}
                  data-conversation={conversation.id}
                  className="border-b border-black/[.05] last:border-0 dark:border-white/[.08]"
                >
                  <td className="px-4 py-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {conversation.id}
                  </td>
                  <td className="px-4 py-2 text-black dark:text-zinc-50">
                    {conversation.status}
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                    <div className="flex flex-col gap-1">
                      <span
                        data-assignee={conversation.id}
                        className={
                          pending
                            ? 'italic text-zinc-400 dark:text-zinc-500'
                            : undefined
                        }
                      >
                        {conversation.assigneeName ?? '—'}
                        {pending ? ' (claiming…)' : ''}
                      </span>
                      {/* The correction. It is deliberately next to the name it
                          contradicts rather than in a toast at the edge of the
                          screen: the user's attention is on the row they just
                          clicked, and that is where the answer has to be. */}
                      {conflict ? (
                        <span
                          data-conflict={conversation.id}
                          role="status"
                          className="text-xs text-amber-700 dark:text-amber-500"
                        >
                          not yours — {conflict}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td
                    data-version={conversation.id}
                    className="px-4 py-2 font-mono text-xs text-zinc-500 dark:text-zinc-400"
                  >
                    {conversation.version}
                  </td>
                  <td className="px-4 py-2">
                    {conversation.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {conversation.tags.map((tag) => (
                          <span
                            key={tag.id}
                            className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs whitespace-nowrap text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-zinc-400 dark:text-zinc-600">
                        —
                      </span>
                    )}
                  </td>
                  {/* Raw ISO, not toLocaleString(). The server's timezone is the
                      container's, not the reader's, so a "friendly" format here
                      would be confidently wrong. */}
                  <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                    <div className="flex items-center gap-3">
                      <span>{conversation.updatedAt}</span>
                      {me ? (
                        <button
                          type="button"
                          data-claim={conversation.id}
                          onClick={() => claim(conversation)}
                          className="rounded border border-black/[.12] px-2 py-0.5 text-xs whitespace-nowrap text-black hover:bg-zinc-100 dark:border-white/[.18] dark:text-zinc-50 dark:hover:bg-zinc-900"
                        >
                          assign to me
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {optimisticRows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400"
                >
                  No conversations here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-4 py-2 font-mono text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      )}

      {/* No count, and that is not an omission. The cursor arm does not run a
          count(*), so "showing 150 of 1,000,000" is a number the server does
          not have. Saying how many are loaded is the honest version. */}
      <div className="flex items-center justify-between text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">
          {rows.length} loaded{cursor ? '' : ' · that’s all of them'}
        </p>
        {cursor && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="rounded border border-black/[.12] px-3 py-1 text-sm text-black hover:bg-zinc-100 disabled:opacity-50 dark:border-white/[.18] dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            {loading ? 'loading…' : 'load more'}
          </button>
        )}
      </div>
    </>
  );
}
