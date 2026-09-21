import {
  cacheArm,
  fetchAgents,
  fetchConversation,
  fetchMessages,
  type CacheArm,
} from '@/lib/api';
import { logger, since } from '@/lib/logger';
import { renderStartedAt } from '@/lib/render-timing';
import type { Metadata } from 'next';
import Link from 'next/link';
import { after } from 'next/server';
import { setConversationStatus } from '../actions';
import { ServedLine } from '../served';

const DEFAULT_ORG_ID = '1';

/** `?a=1&a=2` gives an array. Take the first and move on. */
const first = (value: string | string[] | undefined, fallback: string) =>
  (Array.isArray(value) ? value[0] : value) ?? fallback;

/** The three bits of state this page carries, read once. */
async function stateOf(props: PageProps<'/conversations/[id]'>) {
  const [{ id }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  return {
    id,
    orgId: first(searchParams.org, DEFAULT_ORG_ID),
    me: first(searchParams.me, ''),
    cache: cacheArm(first(searchParams.cache, 'tagged')),
  };
}

/**
 * The title is the status, so a stale title is visible in the tab strip. The
 * fetch is memoized with the page body's — one API request for three calls —
 * see `StatusForm` for the measurement.
 */
export async function generateMetadata(
  props: PageProps<'/conversations/[id]'>,
): Promise<Metadata> {
  const { id, orgId, cache } = await stateOf(props);
  const result = await fetchConversation(orgId, id, cache);
  return {
    title: result.ok
      ? `${result.conversation.status} · ${id.slice(0, 8)}`
      : `conversation ${id.slice(0, 8)}`,
  };
}

/**
 * The write, as a Server Component that fetches the row it acts on.
 *
 * It could take the status as a prop. It fetches instead, on purpose: this is
 * the request memoization demonstration. The page body already called
 * `fetchConversation` with these arguments in this render, and Next hands
 * this call the same response — the line beside the button says `cache ·
 * filled by this render`, and on the `nostore` arm the API logs ONE request
 * for the row per view, not three (this, the body, `generateMetadata`).
 * Measured, with one exception worth knowing: the first render of a freshly
 * compiled route in dev logged all three. Memoization dies with the request;
 * it cannot serve a stale read across a navigation.
 *
 * Hidden fields carry the state the action needs and the arm decides what it
 * expires afterwards. One button that flips to the other status — a select
 * would need JS or a second submit.
 */
async function StatusForm({
  orgId,
  id,
  cache,
}: {
  orgId: string;
  id: string;
  cache: CacheArm;
}) {
  const result = await fetchConversation(orgId, id, cache);
  if (!result.ok) return null;
  const status = result.conversation.status;

  return (
    <form
      action={setConversationStatus}
      data-status-form
      className="flex items-baseline gap-3 text-sm"
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="cache" value={cache} />
      <input
        type="hidden"
        name="status"
        value={status === 'open' ? 'closed' : 'open'}
      />
      <button
        type="submit"
        className="rounded border border-black/[.12] px-3 py-1 text-xs text-black hover:bg-zinc-100 dark:border-white/[.18] dark:text-zinc-50 dark:hover:bg-zinc-900"
      >
        {status === 'open' ? 'close' : 'reopen'}
      </button>
      <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
        cache arm <span data-cache-arm={cache}>{cache}</span> ·{' '}
        <ServedLine
          name="form"
          served={result.served}
          pageRid={result.requestId}
        />
      </span>
    </form>
  );
}

/**
 * One conversation. Card 18.
 *
 * A Server Component with a form and a link and nothing else — zero
 * application JavaScript, like the imports page. The form posts to a Server
 * Action, which works with JS off (a full POST and re-render) and on (an RPC
 * and a soft re-render); either way the response is a render, and on a cached
 * arm that render is where the stale read shows up: the row you just closed,
 * still `open`, in the response to the click that closed it.
 *
 * Reading `searchParams` makes the route dynamic — no Full Route Cache — on
 * purpose. Excluding a layer by construction is how the drill keeps the
 * suspect list at three, and the `next build` table (`ƒ`) is the evidence.
 */
export default async function ConversationPage(
  props: PageProps<'/conversations/[id]'>,
) {
  const startedAt = renderStartedAt();
  const { id, orgId, me, cache } = await stateOf(props);

  const [result, messages, agents] = await Promise.all([
    fetchConversation(orgId, id, cache),
    fetchMessages(orgId, id, cache),
    fetchAgents(orgId, cache),
  ]);

  after(() => {
    logger.info(
      {
        rid: result.requestId,
        route: '/conversations/[id]',
        orgId,
        conversationId: id,
        arm: cache,
        totalMs: since(startedAt),
        upstreamMs: result.durMs,
        served: {
          conversation: result.served.from,
          messages: messages.served.from,
          agents: agents.served.from,
        },
      },
      'page_render',
    );
  });

  const inbox = `/conversations?${new URLSearchParams({
    org: orgId,
    ...(me ? { me } : {}),
    ...(cache !== 'tagged' ? { cache } : {}),
  })}`;

  const assigneeName = result.ok
    ? ((agents.ok
        ? agents.agents.find((a) => a.id === result.conversation.assigneeId)
            ?.name
        : null) ?? (result.conversation.assigneeId ? 'unknown' : null))
    : null;

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-16">
        <p className="text-sm">
          {/* next/link on purpose. The Back button and this link are the two
              ways back to the inbox, and they are not the same navigation:
              Back reuses what the router already has, a Link fetches. Card
              18's second test is the difference. */}
          <Link
            href={inbox}
            data-inbox-link
            className="text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            ← back to inbox
          </Link>
        </p>

        {result.ok ? (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="font-mono text-lg font-semibold tracking-tight break-all text-black dark:text-zinc-50">
                {result.conversation.id}
              </h1>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                status{' '}
                <span
                  data-status={result.conversation.status}
                  className="font-medium text-black dark:text-zinc-50"
                >
                  {result.conversation.status}
                </span>{' '}
                · assignee <span data-assignee>{assigneeName ?? '—'}</span> · v
                {result.conversation.version} · updated{' '}
                {result.conversation.updatedAt} · last message{' '}
                {result.conversation.lastMessageAt}
              </p>
            </div>

            <StatusForm orgId={orgId} id={id} cache={cache} />

            <ol className="flex flex-col gap-2 rounded-lg border border-black/[.08] bg-white p-4 text-sm dark:border-white/[.145] dark:bg-zinc-950">
              {messages.ok ? (
                messages.messages.map((m) => (
                  <li key={m.id} data-message={m.id} className="flex flex-col">
                    <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {m.createdAt}
                    </span>
                    <span className="text-black dark:text-zinc-50">
                      {m.message}
                    </span>
                  </li>
                ))
              ) : (
                <li className="text-red-800 dark:text-red-300">
                  messages unavailable — {messages.error}
                </li>
              )}
            </ol>
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

        {/* The evidence. Three fetches, three answers. When `conversation`
            says `cache` with a rid that is not this page's, the API did not
            run for this render — `pnpm logs:trace <this rid>` has no API line,
            `pnpm logs:trace <filled-by rid>` has the one that did. */}
        <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
          fetched from {result.source} in {result.durMs}ms
          <br />
          rid {result.requestId}
          <br />
          <ServedLine
            name="conversation"
            served={result.served}
            pageRid={result.requestId}
          />{' '}
          ·{' '}
          <ServedLine
            name="messages"
            served={messages.served}
            pageRid={result.requestId}
          />{' '}
          ·{' '}
          <ServedLine
            name="agents"
            served={agents.served}
            pageRid={result.requestId}
          />
        </p>
      </main>
    </div>
  );
}
