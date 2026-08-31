'use client';

import type { Conversation } from '@/lib/api';
import { useState } from 'react';

export function ConversationList({
  initialItems,
  initialCursor,
  query,
}: {
  initialItems: Conversation[];
  initialCursor: string | null;
  query: Record<string, string>;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor || loading) return;
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
      setItems((current) => [...current, ...page.items]);
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
              <th className="px-4 py-3 font-medium">tags</th>
              <th className="px-4 py-3 font-medium">updated_at</th>
              <th className="px-4 py-3 font-medium">created_at</th>
            </tr>
          </thead>
          <tbody>
            {items.map((conversation) => (
              <tr
                key={conversation.id}
                className="border-b border-black/[.05] last:border-0 dark:border-white/[.08]"
              >
                <td className="px-4 py-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {conversation.id}
                </td>
                <td className="px-4 py-2 text-black dark:text-zinc-50">
                  {conversation.status}
                </td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {conversation.assigneeName ?? '—'}
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
                    <span className="text-zinc-400 dark:text-zinc-600">—</span>
                  )}
                </td>
                {/* Raw ISO, not toLocaleString(). The server's timezone is the
                    container's, not the reader's, so a "friendly" format here
                    would be confidently wrong. */}
                <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {conversation.updatedAt}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {conversation.createdAt}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
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
          {items.length} loaded{cursor ? '' : ' · that’s all of them'}
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
