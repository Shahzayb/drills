import { fetchConversations, isCursorPage } from '@/lib/api';
import { logger, since } from '@/lib/logger';
import { renderStartedAt } from '@/lib/render-timing';
import { after } from 'next/server';
import { ConversationList } from './conversation-list';

// There is no auth in this repo, so the tenant is a URL parameter with a
// default. `?org=2` is how tenant isolation gets poked at by hand later.
const DEFAULT_ORG_ID = '1';
// Matches the API's own default. Stated here anyway rather than relying on the
// API's, so the page's URLs are always complete and shareable.
const DEFAULT_PAGE_SIZE = '50';
const DEFAULT_SORT = 'updated_at';

/** `?a=1&a=2` gives an array. Take the first and move on. */
const first = (value: string | string[] | undefined, fallback: string) =>
  (Array.isArray(value) ? value[0] : value) ?? fallback;

/**
 * Server Component. Everything below runs on the Next server, once, per
 * request: the fetch, the JSON parse, the map. The browser receives HTML.
 *
 * Reading `searchParams` opts this route into dynamic rendering — it cannot be
 * prerendered at build time because the page number is not known then. That is
 * correct here and worth knowing rather than discovering.
 *
 * No `loading.tsx` and no <Suspense>: the card wants a blocking server render
 * with no spinner, so the absence is the point.
 *
 * Card 10 gives this page two modes. The default is **keyset**: the first page
 * is fetched here, on the server, and handed to a client component that appends
 * the rest through the cursor. `?mode=offset` is the numbered pager this page
 * has had since drill 03 — kept because "jump to page 40" is the one thing a
 * cursor cannot do, and because it is the other arm of the measurement.
 * See plans/2026-08-26_drill-10-keyset-pagination.md.
 */
export default async function ConversationsPage(
  props: PageProps<'/conversations'>,
) {
  const startedAt = renderStartedAt();
  const searchParams = await props.searchParams;

  const orgId = first(searchParams.org, DEFAULT_ORG_ID);
  const page = first(searchParams.page, '1');
  const pageSize = first(searchParams.pageSize, DEFAULT_PAGE_SIZE);
  const sort = first(searchParams.sort, DEFAULT_SORT);
  // Card 09's filter. No defaults: an absent status means "both", which is a
  // different query from either value and the one the composite index is
  // measured against. See plans/2026-08-25_drill-09-index-selectivity.md.
  const status = first(searchParams.status, '');
  const updatedFrom = first(searchParams.updatedFrom, '');
  const updatedTo = first(searchParams.updatedTo, '');
  // Anything that is not the literal 'offset' is keyset — a typo'd mode lands
  // on the default rather than on an error page.
  const mode = first(searchParams.mode, 'keyset') === 'offset' ? 'offset' : 'keyset'; // prettier-ignore

  const result = await fetchConversations({
    orgId,
    page,
    pageSize,
    sort,
    status,
    updatedFrom,
    updatedTo,
    paging: mode === 'keyset' ? 'keyset' : undefined,
  });

  // Timed *inside* the callback on purpose: `after` runs once the response is
  // finished, and the flush is part of the render. Stopping the clock before
  // `return` would time the data fetch only and report the rest as zero.
  //
  // The id is captured in the closure rather than read inside, because request
  // APIs like headers() may only be called inside an `after` callback in Route
  // Handlers and Server Functions — not in a Server Component.
  //
  // No `status`: a Server Component cannot know the HTTP status of the response
  // it is part of. The upstream status is on upstream_fetch.
  after(() => {
    logger.info(
      {
        rid: result.requestId,
        route: '/conversations',
        orgId,
        totalMs: since(startedAt),
        upstreamMs: result.durMs,
      },
      'page_render',
    );
  });

  // One link builder for every link on the page, because the bug it prevents is
  // real and quiet: build the "next page" URL from scratch and the active
  // filter silently disappears on the second page. Every link starts from the
  // full current state and overrides only what it changes.
  const linkTo = (overrides: Record<string, string>) => {
    const next = new URLSearchParams({
      org: orgId,
      page,
      pageSize,
      sort,
      // Carried like every other bit of state: switch the sort while paging by
      // cursor and the numbered pager should not reappear underneath you.
      ...(mode === 'offset' ? { mode } : {}),
      ...overrides,
    });
    // Same rule as lib/api.ts: empty means absent, so a cleared filter leaves
    // the URL rather than sitting in it as `status=`.
    for (const [key, value] of [
      ['status', status],
      ['updatedFrom', updatedFrom],
      ['updatedTo', updatedTo],
    ] as const) {
      const chosen = overrides[key] ?? value;
      if (chosen) next.set(key, chosen);
      else next.delete(key);
    }
    return `/conversations?${next}`;
  };

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-16">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Conversations
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Org {orgId}, sorted by {sort} desc. The first page is rendered on
            the server either way —{' '}
            {mode === 'keyset'
              ? 'load more fetches the next cursor page'
              : 'this is the numbered pager, and it needs no JavaScript'}
            .
          </p>
        </div>

        {/* Sorting and the status filter are sets of links, not dropdowns,
            because a dropdown needs client JavaScript and this page
            deliberately ships none. Every one of them resets to page 1: a
            filter that keeps you on page 40 of a list that is now 3 pages long
            renders an empty table and reads as a bug. */}
        <div className="flex flex-col gap-3 text-sm">
          <nav className="flex items-baseline gap-3">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              sort
            </span>
            {['updated_at', 'created_at'].map((column) => (
              <a
                key={column}
                href={linkTo({ sort: column, page: '1' })}
                className={
                  column === sort
                    ? 'font-medium text-black underline dark:text-zinc-50'
                    : 'text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50'
                }
              >
                {column}
              </a>
            ))}
          </nav>

          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            <a
              href={`/search?org=${orgId}`}
              className="text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              search messages
            </a>
          </p>

          <nav className="flex items-baseline gap-3">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              status
            </span>
            {[
              { value: '', label: 'all' },
              { value: 'open', label: 'open' },
              { value: 'closed', label: 'closed' },
            ].map((option) => (
              <a
                key={option.label}
                href={linkTo({ status: option.value, page: '1' })}
                className={
                  option.value === status
                    ? 'font-medium text-black underline dark:text-zinc-50'
                    : 'text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50'
                }
              >
                {option.label}
              </a>
            ))}
          </nav>

          {/* A GET form, so the range lands in the URL and the page stays
              shareable and cacheable — and, like everything else here, needs no
              JavaScript. The hidden inputs carry the state the form does not
              own; without them, submitting the dates would reset org and sort.
              <input type="date"> submits YYYY-MM-DD, which the API reads as
              midnight in the *server's* timezone. */}
          <form method="get" className="flex flex-wrap items-baseline gap-3">
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="pageSize" value={pageSize} />
            <input type="hidden" name="sort" value={sort} />
            <input type="hidden" name="status" value={status} />
            <input type="hidden" name="page" value="1" />
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              updated from{' '}
              <input
                type="date"
                name="updatedFrom"
                defaultValue={updatedFrom}
                className="rounded border border-black/[.12] bg-white px-2 py-1 font-mono text-xs text-black dark:border-white/[.18] dark:bg-zinc-950 dark:text-zinc-50"
              />
            </label>
            <label className="text-xs text-zinc-500 dark:text-zinc-400">
              to{' '}
              <input
                type="date"
                name="updatedTo"
                defaultValue={updatedTo}
                className="rounded border border-black/[.12] bg-white px-2 py-1 font-mono text-xs text-black dark:border-white/[.18] dark:bg-zinc-950 dark:text-zinc-50"
              />
            </label>
            <button
              type="submit"
              className="rounded border border-black/[.12] px-3 py-1 text-xs text-black hover:bg-zinc-100 dark:border-white/[.18] dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              apply
            </button>
            {(updatedFrom || updatedTo || status) && (
              <a
                href={linkTo({
                  status: '',
                  updatedFrom: '',
                  updatedTo: '',
                  page: '1',
                })}
                className="text-xs text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
              >
                clear filters
              </a>
            )}
          </form>
        </div>

        {result.ok ? (
          <>
            <ConversationList
              initialItems={result.page.items}
              initialCursor={
                isCursorPage(result.page) ? result.page.nextCursor : null
              }
              query={{
                org: orgId,
                pageSize,
                sort,
                ...(status ? { status } : {}),
                ...(updatedFrom ? { updatedFrom } : {}),
                ...(updatedTo ? { updatedTo } : {}),
              }}
            />

            {!isCursorPage(result.page) && (
              <div className="flex items-center justify-between text-sm">
                <p className="text-zinc-600 dark:text-zinc-400">
                  Page {result.page.page} of {result.page.totalPages || 1} ·{' '}
                  {result.page.total} conversations
                </p>
                {/* Plain anchors, not next/link. A full document request is what
                    makes "this works with JavaScript off" provable rather than
                    merely claimed. next/link is the normal choice in a real app —
                    see the plan file. */}
                <div className="flex gap-4">
                  {result.page.page > 1 ? (
                    <a
                      href={linkTo({ page: String(result.page.page - 1) })}
                      className="underline hover:text-black dark:hover:text-zinc-50"
                    >
                      ← previous
                    </a>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-600">
                      ← previous
                    </span>
                  )}
                  {result.page.page < result.page.totalPages ? (
                    <a
                      href={linkTo({ page: String(result.page.page + 1) })}
                      className="underline hover:text-black dark:hover:text-zinc-50"
                    >
                      next →
                    </a>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-600">
                      next →
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* The two arms, and what each costs, stated on the page rather than
                only in the plan. `total` is missing from the cursor arm because
                the API does not compute one — that is the trade, not a bug. */}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {mode === 'keyset' ? (
                <>
                  cursor paging — no total, no page numbers, flat cost at any
                  depth.{' '}
                  <a
                    href={linkTo({ mode: 'offset', page: '1' })}
                    className="underline hover:text-black dark:hover:text-zinc-50"
                  >
                    switch to numbered pages
                  </a>
                </>
              ) : (
                <>
                  offset paging — page numbers and a total, and every page costs
                  more than the last.{' '}
                  <a
                    href={linkTo({ mode: 'keyset', page: '1' })}
                    className="underline hover:text-black dark:hover:text-zinc-50"
                  >
                    switch to load-more
                  </a>
                </>
              )}
            </p>

            {/* Load-more is the one thing on this page that needs JavaScript.
                Rather than degrade silently into a list that cannot be
                continued, say so and point at the path that does not. */}
            {mode === 'keyset' && (
              <noscript>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Load more needs JavaScript.{' '}
                  <a
                    className="underline"
                    href={linkTo({ mode: 'offset', page: '1' })}
                  >
                    Use numbered pages instead
                  </a>{' '}
                  — they are plain links and work without it.
                </p>
              </noscript>
            )}
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

        {/* The id is on the response header too, but printing it here means
            you can copy it out of the page you are looking at and go straight
            to `pnpm logs:trace <id>`. */}
        <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
          fetched from {result.source} in {result.durMs}ms
          <br />
          rid {result.requestId}
        </p>
      </main>
    </div>
  );
}
