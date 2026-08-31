import { searchMessages } from '@/lib/api';
import { logger, since } from '@/lib/logger';
import { renderStartedAt } from '@/lib/render-timing';
import { after } from 'next/server';

const DEFAULT_ORG_ID = '1';
const DEFAULT_LIMIT = '20';

const first = (value: string | string[] | undefined, fallback: string) =>
  (Array.isArray(value) ? value[0] : value) ?? fallback;

export default async function SearchPage(props: PageProps<'/search'>) {
  const startedAt = renderStartedAt();
  const searchParams = await props.searchParams;

  const orgId = first(searchParams.org, DEFAULT_ORG_ID);
  const limit = first(searchParams.limit, DEFAULT_LIMIT);
  const q = first(searchParams.q, '');

  const result = q ? await searchMessages({ orgId, q, limit }) : null;

  after(() =>
    logger.info(
      {
        route: '/search',
        orgId,
        q,
        hits: result?.ok ? result.page.items.length : null,
        strategy: result?.ok ? result.page.strategy : null,
        upstreamMs: result?.durMs ?? 0,
        totalMs: since(startedAt),
      },
      'page_render',
    ),
  );

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-16">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-medium tracking-tight text-black dark:text-zinc-50">
            Search messages
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Full-text search over ten million message bodies, org {orgId}.{' '}
            <a
              href={`/conversations?org=${orgId}`}
              className="text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              conversations
            </a>
          </p>

          {/* A GET form, so the term lands in the URL and the page stays
              shareable — and, like the date range on /conversations, needs no
              JavaScript. The hidden inputs carry the state the form does not
              own; without them, submitting would reset org and limit. */}
          <form method="get" className="flex flex-wrap items-baseline gap-3">
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="limit" value={limit} />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="refunds, csv export, ERR_2452"
              size={36}
              className="rounded border border-black/[.12] bg-white px-2 py-1 font-mono text-xs text-black dark:border-white/[.18] dark:bg-zinc-950 dark:text-zinc-50"
            />
            <button
              type="submit"
              className="rounded border border-black/[.12] px-3 py-1 text-xs text-black hover:bg-zinc-100 dark:border-white/[.18] dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              search
            </button>
            {q && (
              <a
                href={`/search?org=${orgId}&limit=${limit}`}
                className="text-xs text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
              >
                clear
              </a>
            )}
          </form>
        </div>

        {result === null ? (
          <div className="rounded-lg border border-black/[.08] bg-white p-6 dark:border-white/[.145] dark:bg-zinc-950">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Type a term above. Try <code className="font-mono">refunds</code>,
              which matches messages containing <em>refunded</em> — and{' '}
              <code className="font-mono">xport</code>, which matches nothing at
              all.
            </p>
          </div>
        ) : result.ok ? (
          <>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {result.page.items.length} shown · {result.page.strategy} arm
            </p>
            <div className="overflow-x-auto rounded-lg border border-black/[.08] bg-white dark:border-white/[.145] dark:bg-zinc-950">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-black/[.08] dark:border-white/[.145]">
                  <tr className="text-xs text-zinc-500 dark:text-zinc-400">
                    <th className="px-4 py-2 font-normal">id</th>
                    <th className="px-4 py-2 font-normal">message</th>
                    <th className="px-4 py-2 font-normal">created_at</th>
                  </tr>
                </thead>
                <tbody>
                  {result.page.items.length === 0 ? (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-4 py-6 text-zinc-500 dark:text-zinc-400"
                      >
                        No messages match that term.
                      </td>
                    </tr>
                  ) : (
                    result.page.items.map((hit) => (
                      <tr
                        key={hit.id}
                        className="border-b border-black/[.05] last:border-0 dark:border-white/[.08]"
                      >
                        <td className="px-4 py-2 font-mono text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                          {hit.id}
                        </td>
                        <td className="px-4 py-2 text-zinc-800 dark:text-zinc-200">
                          {hit.message}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                          {hit.createdAt}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900/50 dark:bg-red-950/30">
            <p className="font-medium text-red-900 dark:text-red-200">
              The API refused this request
              {result.status ? ` (${result.status})` : ''}
            </p>
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-red-800 dark:text-red-300">
              {result.error}
            </pre>
          </div>
        )}

        {result && (
          <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
            fetched from {result.source} in {result.durMs}ms
            <br />
            rid {result.requestId}
          </p>
        )}
      </main>
    </div>
  );
}
