import { fetchConversations } from "@/lib/api";

// There is no auth in this repo, so the tenant is a URL parameter with a
// default. `?org=2` is how tenant isolation gets poked at by hand later.
const DEFAULT_ORG_ID = "1";
// Matches the API's own default. Stated here anyway rather than relying on the
// API's, so the page's URLs are always complete and shareable.
const DEFAULT_PAGE_SIZE = "50";
const DEFAULT_SORT = "updated_at";

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
 * with no spinner, so the absence is the point. Drill 10 changes that.
 */
export default async function ConversationsPage(
  props: PageProps<"/conversations">,
) {
  const searchParams = await props.searchParams;

  const orgId = first(searchParams.org, DEFAULT_ORG_ID);
  const page = first(searchParams.page, "1");
  const pageSize = first(searchParams.pageSize, DEFAULT_PAGE_SIZE);
  const sort = first(searchParams.sort, DEFAULT_SORT);

  const result = await fetchConversations({ orgId, page, pageSize, sort });

  const href = (targetPage: number) =>
    `/conversations?${new URLSearchParams({
      org: orgId,
      page: String(targetPage),
      pageSize,
      sort,
    })}`;

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-16">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Conversations
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Org {orgId}, sorted by {sort} desc. Rendered on the server — disable
            JavaScript and the rows are still here.
          </p>
        </div>

        {/* Sorting is a set of links, not a dropdown, because a dropdown needs
            client JavaScript and this page deliberately ships none. */}
        <nav className="flex gap-3 text-sm">
          {["updated_at", "created_at"].map((column) => (
            <a
              key={column}
              href={`/conversations?${new URLSearchParams({
                org: orgId,
                page: "1",
                pageSize,
                sort: column,
              })}`}
              className={
                column === sort
                  ? "font-medium text-black underline dark:text-zinc-50"
                  : "text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
              }
            >
              {column}
            </a>
          ))}
        </nav>

        {result.ok ? (
          <>
            <div className="overflow-x-auto rounded-lg border border-black/[.08] bg-white dark:border-white/[.145] dark:bg-zinc-950">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-black/[.08] text-xs text-zinc-500 dark:border-white/[.145] dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">id</th>
                    <th className="px-4 py-3 font-medium">status</th>
                    <th className="px-4 py-3 font-medium">assignee</th>
                    <th className="px-4 py-3 font-medium">updated_at</th>
                    <th className="px-4 py-3 font-medium">created_at</th>
                  </tr>
                </thead>
                <tbody>
                  {result.page.items.map((conversation) => (
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
                        {conversation.assigneeId ?? "—"}
                      </td>
                      {/* Raw ISO, not toLocaleString(). The server's timezone is
                          the container's, not the reader's, so a "friendly"
                          format here would be confidently wrong. */}
                      <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {conversation.updatedAt}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {conversation.createdAt}
                      </td>
                    </tr>
                  ))}
                  {result.page.items.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400"
                      >
                        No conversations on this page.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between text-sm">
              <p className="text-zinc-600 dark:text-zinc-400">
                Page {result.page.page} of {result.page.totalPages || 1} ·{" "}
                {result.page.total} conversations
              </p>
              {/* Plain anchors, not next/link. A full document request is what
                  makes "this works with JavaScript off" provable rather than
                  merely claimed. next/link is the normal choice in a real app —
                  see drills/03-endpoint-and-rsc-page.md. */}
              <div className="flex gap-4">
                {result.page.page > 1 ? (
                  <a
                    href={href(result.page.page - 1)}
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
                    href={href(result.page.page + 1)}
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
          </>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900/50 dark:bg-red-950/30">
            <p className="font-medium text-red-900 dark:text-red-200">
              The API refused this request
              {result.status ? ` (${result.status})` : ""}
            </p>
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-red-800 dark:text-red-300">
              {result.error}
            </pre>
          </div>
        )}

        <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
          fetched from {result.source}
        </p>
      </main>
    </div>
  );
}
