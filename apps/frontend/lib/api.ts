import { logger, since } from './logger';
import { getRequestId } from './request-context';
import { REQUEST_ID_HEADER } from './request-id';
import { injectTraceContext } from './trace';

// The API is reached by Compose service name, not localhost. This only works
// from the Next *server* — a client component would have to use the published
// host port instead, because the browser is not on the Compose network.
const API_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3002';

// Mirrors apps/backend/src/observability/request-context.ts, same reason
// REQUEST_ID_HEADER is duplicated in ./request-id.
const SERVED_AT_HEADER = 'x-served-at';

/**
 * Card 18's four arms, one URL parameter. `?cache=`.
 *
 * - `nostore`  every fetch `cache: 'no-store'`. The "just disable caching" fix.
 * - `cached`   `force-cache` with tags, and NO revalidation after a write. The
 *              bug the card describes, reproduced on purpose.
 * - `tagged`   the same cache, and a write expires exactly the tags it touched.
 *              What ships.
 * - `blanket`  the same cache, and a write expires the whole org — every list,
 *              every row, the 5GB stats aggregate. Correct, and the opposite
 *              failure.
 *
 * A URL parameter rather than an environment variable, the `?mode=`/`?stats=`
 * precedent: the arms run in ONE process and share ONE cache, so they can be
 * interleaved in a sitting. Anything unrecognised lands on `tagged`.
 * See plans/2026-09-21_drill-18-next-cache-layers.md.
 */
export type CacheArm = 'nostore' | 'cached' | 'tagged' | 'blanket';
export const cacheArm = (value: string): CacheArm =>
  value === 'nostore' || value === 'cached' || value === 'blanket'
    ? value
    : 'tagged';

/**
 * The tag scheme. A tag is a name a write can call out; every cached fetch
 * carries the names of the writes that would make it wrong.
 *
 * `org` sits on every fetch the org has, so one call can empty the lot — that
 * is the blanket arm's handle, and the coarsest thing a write could name.
 * `conversations` is every list variant at once (sort, filter, page, cursor),
 * because a status change moves a row across the `open`/`closed` filters and
 * re-sorts every `updated_at` page: org-wide is the CORRECT granularity for the
 * list, not the lazy one. `conversation` is one row and its messages.
 */
export const tags = {
  org: (orgId: string) => `org:${orgId}`,
  conversations: (orgId: string) => `org:${orgId}:conversations`,
  agents: (orgId: string) => `org:${orgId}:agents`,
  stats: (orgId: string) => `org:${orgId}:stats`,
  conversation: (id: string) => `conversation:${id}`,
};

/**
 * What one write to one conversation expires, per arm. Empty means "nothing is
 * cached that this could invalidate" (`nostore`) or "nothing is invalidated
 * and that is the bug" (`cached`). The Server Actions and `/api/revalidate`
 * both read this, so the granularity decision has exactly one home.
 */
export function tagsAfterWrite(
  arm: CacheArm,
  { orgId, id }: { orgId: string; id: string },
): string[] {
  switch (arm) {
    case 'tagged':
      return [tags.conversation(id), tags.conversations(orgId)];
    case 'blanket':
      return [tags.org(orgId)];
    default:
      return [];
  }
}

/** How one fetch asks Next to cache it. `no-store` is what every fetch in this
 *  file did before card 18. */
type CachePolicy = { tags: string[]; revalidate?: number } | 'no-store';

/** The policy for one arm: three of the four cache. The arms differ in what a
 *  WRITE does afterwards, not in what a read asks for. */
const policyFor = (
  arm: CacheArm,
  cacheTags: string[],
  revalidate?: number,
): CachePolicy =>
  arm === 'nostore' ? 'no-store' : { tags: cacheTags, revalidate };

/**
 * Who answered a fetch, and when. Card 18's instrument.
 *
 * Two answers, observed rather than reasoned:
 *
 * - `origin`  the API ran it, for this call.
 * - `cache`   an answer produced before this call asked. `rid` says which
 *             request produced it: this page's own id means an earlier call
 *             in THIS render did — request memoization, which dies with the
 *             request; any other id means an earlier request — the data
 *             cache, the layer that survives navigations, reloads and other
 *             users.
 *
 * One label for both because the predicate cannot tell them apart and should
 * not pretend to: a memoized response also predates its second asker. The rid
 * is what separates them, and the page prints it.
 */
export interface Served {
  from: 'origin' | 'cache';
  /** Now minus the API's `x-served-at`: how old the answer is. */
  ageMs: number;
  /** The request that actually ran, as the API echoed it. On a `cache` answer
   *  `pnpm logs:trace` on it finds the request that filled the entry. */
  rid: string | null;
}

/** A failed hop still happened and still took time. */
class UpstreamError extends Error {
  constructor(
    readonly cause: unknown,
    readonly durMs: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * The Next -> Nest hop, timed, with the id attached.
 *
 * The hop with no ambient context to lean on: within one process an
 * AsyncLocalStorage carries the id for free, but across a process boundary the
 * wire is the only channel. Everything downstream hangs off this header.
 *
 * **Except on a cache-eligible fetch, which sends no `x-request-id`.** Next's
 * data cache keys a fetch on its URL, method, body AND headers
 * (`server/lib/incremental-cache/index.js`, `generateCacheKey`). It strips
 * `traceparent` and `tracestate` from that key by name — it knows the W3C
 * headers would fragment it — and knows nothing about ours. A per-request id
 * in the headers is a per-request cache key, and the cache never hits. Measured
 * before this line existed: 0 hits in 10 loads. So a cached fetch carries the
 * trace and not the id; the id of the request that actually ran comes back in
 * the response, and `served.rid` reports it.
 */
async function callApi(
  url: string,
  requestId: string,
  init?: RequestInit,
  policy: CachePolicy = 'no-store',
): Promise<{ response: Response; durMs: number; served: Served }> {
  const startedAt = performance.now();
  // Wall clock, for the predicate below. `performance.now()` is monotonic and
  // says nothing about when the API's clock produced a response.
  const askedAt = Date.now();

  const record = (status: number | null, served?: Served) => {
    const durMs = since(startedAt);
    logger.debug(
      {
        rid: requestId,
        url,
        status,
        durMs,
        served: served?.from ?? null,
        ageMs: served?.ageMs ?? null,
        originRid: served?.rid ?? null,
      },
      'upstream_fetch',
    );
    return durMs;
  };

  // Headers, not a spread: RequestInit.headers may legitimately be a Headers
  // instance or an array of pairs, and spreading either silently yields {} —
  // dropping every header without a word.
  const headers = new Headers(init?.headers);
  if (policy === 'no-store') headers.set(REQUEST_ID_HEADER, requestId);
  // The standard's version of the line above, and the two are not redundant.
  // x-request-id is ours and carries a flat, human-readable id. `traceparent`
  // is W3C and carries trace id *plus this span's id*, which is what makes the
  // API's spans children of this render instead of a second, unrelated trace.
  // Nothing on the Nest side reads it explicitly — instrumentation-http does.
  injectTraceContext(headers);

  const caching: RequestInit =
    policy === 'no-store'
      ? { cache: 'no-store' }
      : {
          cache: 'force-cache',
          next: { tags: policy.tags, revalidate: policy.revalidate },
        };

  try {
    const response = await fetch(url, { ...init, ...caching, headers });

    // The predicate: an answer that predates the question came from a cache.
    // No threshold — a fresh response is stamped after `askedAt` by the API,
    // and both containers read the same Docker VM clock.
    const servedAt = Date.parse(response.headers.get(SERVED_AT_HEADER) ?? '');
    const served: Served = {
      from:
        Number.isFinite(servedAt) && servedAt < askedAt ? 'cache' : 'origin',
      ageMs: Number.isFinite(servedAt) ? Math.max(0, Date.now() - servedAt) : 0,
      rid: response.headers.get(REQUEST_ID_HEADER),
    };
    return { response, durMs: record(response.status, served), served };
  } catch (error) {
    throw new UpstreamError(error, record(null));
  }
}

/** The `served` a failed hop reports: nobody answered. */
const unserved: Served = { from: 'origin', ageMs: 0, rid: null };

export interface Info {
  postgres: {
    version: string;
    serverTime: string;
    poolStats: { total: number; idle: number; waiting: number; max: number };
  };
}

export type InfoResult = (
  { ok: true; info: Info } | { ok: false; error: string }
) & { source: string; requestId: string; durMs: number; served: Served };

/**
 * Next 16 does not cache fetch by default, so this runs per request without
 * any `cache: 'no-store'` opt-out. Failure is returned rather than thrown so
 * the page can render the outage instead of collapsing into an error boundary.
 */
export async function fetchInfo(): Promise<InfoResult> {
  const source = `${API_URL}/info`;
  const requestId = await getRequestId();

  try {
    const { response, durMs, served } = await callApi(source, requestId);
    if (!response.ok) {
      return {
        ok: false,
        error: `API responded ${response.status}`,
        source,
        requestId,
        durMs,
        served,
      };
    }
    return {
      ok: true,
      info: (await response.json()) as Info,
      source,
      requestId,
      durMs,
      served,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
      requestId,
      // The real duration, not 0. A connect timeout is 2s of upstream time, and
      // reporting it as zero would charge it to Next's render in the gap table.
      durMs: error instanceof UpstreamError ? error.durMs : 0,
      served: unserved,
    };
  }
}

export interface Tag {
  id: string;
  name: string;
}

export interface Conversation {
  id: string;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  /** Card 14's optimistic-locking token. Sent back with a claim; the API
   *  refuses the write if it has moved. */
  version: number;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

/** Somebody a conversation can be assigned to. `id` is a membership id, which
 *  is what `assigneeId` holds — not a user id. */
export interface Agent {
  id: string;
  name: string;
}

/** What the API says is true, sent with the 409 that refuses a claim. */
export interface ConflictState {
  assigneeId: string | null;
  assigneeName: string | null;
  version: number;
  updatedAt: string;
}

export interface ConversationPage {
  items: Conversation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Card 10's keyset arm. No `total` and no `totalPages` — the API does not
 *  compute them, deliberately; see the backend service for why. */
export interface ConversationCursorPage {
  items: Conversation[];
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/** Which shape came back. `page` in the body is the discriminator the API
 *  already gives us — the offset arm has one, the cursor arm does not. */
export const isCursorPage = (
  page: ConversationPage | ConversationCursorPage,
): page is ConversationCursorPage => !('total' in page);

export type ConversationsResult = (
  | { ok: true; page: ConversationPage | ConversationCursorPage }
  | { ok: false; error: string; status?: number }
) & { source: string; requestId: string; durMs: number; served: Served };

/**
 * Runs on the Next *server* only — `API_URL` is a Compose service name the
 * browser cannot resolve, and the org header is the kind of thing that becomes
 * a session lookup rather than something a client should be choosing.
 *
 * `page` and `sort` are passed through exactly as they arrived in the URL,
 * unvalidated, on purpose. The API is the thing that owns those rules, and a
 * second copy of them here is a second copy to keep in sync. `?page=-1`
 * therefore renders the API's 400 rather than being quietly corrected — which
 * is the honest behaviour, and what
 * plans/2026-08-09_drill-03-conversation-list.md settles under "Where is the
 * page size validated".
 */
export async function fetchConversations(params: {
  orgId: string;
  page: string;
  pageSize: string;
  sort: string;
  status?: string;
  updatedFrom?: string;
  updatedTo?: string;
  // Card 10. Absent means the offset arm, which is still the API's default.
  paging?: string;
  cursor?: string;
  // Card 18. Which arm this page is on; decides whether the fetch is cached.
  cache: CacheArm;
}): Promise<ConversationsResult> {
  const query = new URLSearchParams({
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
  });

  // Appended only when set, and an empty string counts as unset — an empty
  // <input type="date"> submits `updatedFrom=`, and forwarding that would turn
  // "I cleared the filter" into a 400 from @IsISO8601. Absent and empty mean
  // the same thing to a reader, so they have to mean the same thing here.
  //
  // `cursor` is in the same list for the same reason, and one more: the API
  // rejects a cursor sent to the offset arm outright, so forwarding an empty
  // one would 400 every unpaged request.
  for (const key of [
    'status',
    'updatedFrom',
    'updatedTo',
    'paging',
    'cursor',
  ] as const) {
    const value = params[key];
    if (value) query.set(key, value);
  }

  const source = `${API_URL}/conversations?${query}`;
  const requestId = await getRequestId();

  try {
    // Every list variant carries the org-wide list tag: a status change
    // re-sorts every page and moves the row across every filter, so there is
    // no narrower tag that would be correct.
    const { response, durMs, served } = await callApi(
      source,
      requestId,
      { headers: { 'x-org-id': params.orgId } },
      policyFor(params.cache, [
        tags.org(params.orgId),
        tags.conversations(params.orgId),
      ]),
    );

    if (!response.ok) {
      // The API's 400 body carries which field was wrong. Worth surfacing:
      // "API responded 400" alone would make the page useless for the drill.
      const detail = await response.text();
      return {
        ok: false,
        error: detail || `API responded ${response.status}`,
        status: response.status,
        source,
        requestId,
        durMs,
        served,
      };
    }

    return {
      ok: true,
      page: (await response.json()) as
        ConversationPage | ConversationCursorPage,
      source,
      requestId,
      durMs,
      served,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
      requestId,
      // The real duration, not 0. A connect timeout is 2s of upstream time, and
      // reporting it as zero would charge it to Next's render in the gap table.
      durMs: error instanceof UpstreamError ? error.durMs : 0,
      served: unserved,
    };
  }
}

export interface MessageHit {
  id: string;
  conversationId: string;
  message: string;
  createdAt: string;
}

export interface MessageSearchPage {
  items: MessageHit[];
  strategy: 'like' | 'fts';
}

export type MessageSearchResult = (
  | { ok: true; page: MessageSearchPage }
  | { ok: false; error: string; status?: number }
) & { source: string; requestId: string; durMs: number };

/**
 * Card 11's search endpoint, through the same single hop as everything else —
 * a bare `fetch` here would drop the org header, the request id and the
 * traceparent without saying so.
 *
 * `q` is passed through unvalidated, same rule as `page` and `sort` above: the
 * API owns the length bounds, and a second copy of them here is a second copy
 * to keep in sync. A one-character `q` therefore renders the API's 400.
 */
export async function searchMessages(params: {
  orgId: string;
  q: string;
  limit: string;
}): Promise<MessageSearchResult> {
  const query = new URLSearchParams({ q: params.q, limit: params.limit });
  const source = `${API_URL}/messages/search?${query}`;
  const requestId = await getRequestId();

  try {
    const { response, durMs } = await callApi(source, requestId, {
      headers: { 'x-org-id': params.orgId },
    });

    if (!response.ok) {
      const detail = await response.text();
      return {
        ok: false,
        error: detail || `API responded ${response.status}`,
        status: response.status,
        source,
        requestId,
        durMs,
      };
    }

    return {
      ok: true,
      page: (await response.json()) as MessageSearchPage,
      source,
      requestId,
      durMs,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
      requestId,
      durMs: error instanceof UpstreamError ? error.durMs : 0,
    };
  }
}

export type AgentsResult = (
  { ok: true; agents: Agent[] } | { ok: false; error: string }
) & { served: Served };

/**
 * Who can be assigned a conversation in this org.
 *
 * There is no auth in this repo, so "assign to me" needs a "me" that comes from
 * somewhere. This list is what the page turns into a picker, the same way `?org`
 * stands in for a session. Failure returns an empty list rather than throwing —
 * an inbox with no agent picker is degraded, not broken.
 */
export async function fetchAgents(
  orgId: string,
  cache: CacheArm,
): Promise<AgentsResult> {
  const source = `${API_URL}/conversations/agents`;
  const requestId = await getRequestId();

  try {
    // Cached under the org tags only. Nothing in this app writes memberships,
    // so nothing here can expire it on purpose; the blanket arm does by
    // accident. A real app would tag it `org:<o>:agents` and call that from
    // wherever memberships change.
    const { response, served } = await callApi(
      source,
      requestId,
      { headers: { 'x-org-id': orgId } },
      policyFor(cache, [tags.org(orgId), tags.agents(orgId)]),
    );
    if (!response.ok)
      return { ok: false, error: `API responded ${response.status}`, served };
    return { ok: true, agents: (await response.json()) as Agent[], served };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      served: unserved,
    };
  }
}

/** What `GET /messages/stats` says about an org. Card 17. */
export interface OrgStats {
  messages: number;
  negative: number;
  positive: number;
  /** Messages in the last 90 days. */
  recent: number;
  avgLength: number;
  lastMessageAt: string | null;
  /** `lexicon` — two word lists against the tsvector, not sentiment analysis.
   *  Carried so the widget can say what the number is. */
  method: string;
}

export type OrgStatsResult = (
  { ok: true; stats: OrgStats } | { ok: false; error: string; status?: number }
) & { source: string; requestId: string; durMs: number; served: Served };

/**
 * Card 18's stretch: the widget's staleness budget, in seconds. The aggregate
 * counts months of messages; the whale gains at most a few dozen a minute, so
 * a count sixty seconds old is inside its own noise — and a fresh one costs a
 * 5GB scan. No Server Action changes messages (ingest is a Nest route, which
 * cannot reach this cache), so time is the only revalidation the entry gets on
 * the `tagged` arm. The widget prints its age so the budget is visible.
 */
export const STATS_MAX_AGE_S = 60;

/**
 * The inbox widget's aggregate. Card 17.
 *
 * Slow for the whale on purpose — one sequential scan of the org's messages,
 * nothing cached in front of it — and that is the whole reason the widget
 * exists: to be the slowest thing on the page so the page can be measured
 * waiting for it, and then measured not waiting. The result carries `durMs`
 * so the widget can print what it cost.
 *
 * Failure comes back as a value, the `fetchInfo` shape: a widget that is
 * missing is degraded, and a page that collapses into an error boundary
 * because a side widget timed out is broken.
 */
export async function fetchOrgStats(
  orgId: string,
  cache: CacheArm,
): Promise<OrgStatsResult> {
  const source = `${API_URL}/messages/stats`;
  const requestId = await getRequestId();

  try {
    const { response, durMs, served } = await callApi(
      source,
      requestId,
      { headers: { 'x-org-id': orgId } },
      policyFor(cache, [tags.org(orgId), tags.stats(orgId)], STATS_MAX_AGE_S),
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `API responded ${response.status}`,
        status: response.status,
        source,
        requestId,
        durMs,
        served,
      };
    }
    return {
      ok: true,
      stats: (await response.json()) as OrgStats,
      source,
      requestId,
      durMs,
      served,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
      requestId,
      durMs: error instanceof UpstreamError ? error.durMs : 0,
      served: unserved,
    };
  }
}

/** One conversation, `GET /conversations/:id`. The narrower `get()` shape —
 *  no `assigneeName`, no `tags`; the API's `ConversationSummary`. */
export interface ConversationDetail {
  id: string;
  status: string;
  assigneeId: string | null;
  version: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  message: string;
  createdAt: string;
}

export type ConversationResult = (
  | { ok: true; conversation: ConversationDetail }
  | { ok: false; error: string; status?: number }
) & { source: string; requestId: string; durMs: number; served: Served };

export type MessagesResult = (
  | { ok: true; messages: Message[] }
  | { ok: false; error: string; status?: number }
) & { source: string; requestId: string; durMs: number; served: Served };

/**
 * The detail page's row. Card 18.
 *
 * Tagged with its own id and the org: a write to THIS row expires this entry
 * and nothing else's. Called three times per view on purpose — from
 * `generateMetadata`, the page body and the status form — which is how the
 * memoization claim got measured instead of repeated. See the detail page.
 */
export async function fetchConversation(
  orgId: string,
  id: string,
  cache: CacheArm,
): Promise<ConversationResult> {
  const source = `${API_URL}/conversations/${id}`;
  const requestId = await getRequestId();

  try {
    const { response, durMs, served } = await callApi(
      source,
      requestId,
      { headers: { 'x-org-id': orgId } },
      policyFor(cache, [tags.org(orgId), tags.conversation(id)]),
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `API responded ${response.status}`,
        status: response.status,
        source,
        requestId,
        durMs,
        served,
      };
    }
    return {
      ok: true,
      conversation: (await response.json()) as ConversationDetail,
      source,
      requestId,
      durMs,
      served,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
      requestId,
      durMs: error instanceof UpstreamError ? error.durMs : 0,
      served: unserved,
    };
  }
}

/** The row's messages, under the same tags as the row. Card 18. */
export async function fetchMessages(
  orgId: string,
  id: string,
  cache: CacheArm,
): Promise<MessagesResult> {
  const source = `${API_URL}/conversations/${id}/messages`;
  const requestId = await getRequestId();

  try {
    const { response, durMs, served } = await callApi(
      source,
      requestId,
      { headers: { 'x-org-id': orgId } },
      policyFor(cache, [tags.org(orgId), tags.conversation(id)]),
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `API responded ${response.status}`,
        status: response.status,
        source,
        requestId,
        durMs,
        served,
      };
    }
    return {
      ok: true,
      messages: (await response.json()) as Message[],
      source,
      requestId,
      durMs,
      served,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
      requestId,
      durMs: error instanceof UpstreamError ? error.durMs : 0,
      served: unserved,
    };
  }
}

export type StatusResult =
  | { ok: true; conversation: ConversationDetail }
  | { ok: false; status: number; message: string };

/**
 * The status write, `PATCH /conversations/:id`. Card 18.
 *
 * The second write in this module after `assignConversation`, and the same
 * rules: through `callApi` so the headers travel, failure as a value. A POST-
 * shaped request is never cached, whatever arm the page is on — the arm only
 * decides what the Server Action expires AFTER this returns.
 */
export async function updateConversationStatus(params: {
  orgId: string;
  id: string;
  status: string;
}): Promise<StatusResult> {
  const source = `${API_URL}/conversations/${params.id}`;
  const requestId = await getRequestId();

  try {
    const { response } = await callApi(source, requestId, {
      method: 'PATCH',
      headers: {
        'x-org-id': params.orgId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: params.status }),
    });

    if (response.ok) {
      return {
        ok: true,
        conversation: (await response.json()) as ConversationDetail,
      };
    }

    const body = (await response.json().catch(() => null)) as {
      message?: string | string[];
    } | null;

    return {
      ok: false,
      status: response.status,
      message: Array.isArray(body?.message)
        ? body.message.join(', ')
        : (body?.message ?? `API responded ${response.status}`),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export type AssignResult =
  | { ok: true; conversation: Conversation }
  | { ok: false; status: number; message: string; current?: ConflictState };

/**
 * Claim or release a conversation. Card 14.
 *
 * A 409 is a RESULT, not an exception. Throwing here would send the losing
 * client to an error boundary — a whole-page failure for the one outcome the UI
 * is specifically built to explain — so the conflict comes back as a value with
 * the server's own truth attached.
 *
 * Everything else in this module is a GET. This is the one write, and it still
 * goes through `callApi` so the org header, `x-request-id` and the W3C
 * `traceparent` are attached; a hand-rolled fetch would drop all three without
 * saying so.
 */
export async function assignConversation(params: {
  orgId: string;
  id: string;
  assigneeId: string | null;
  version: number;
}): Promise<AssignResult> {
  const source = `${API_URL}/conversations/${params.id}/assign`;
  const requestId = await getRequestId();

  try {
    const { response } = await callApi(source, requestId, {
      method: 'POST',
      headers: {
        'x-org-id': params.orgId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        assigneeId: params.assigneeId,
        version: params.version,
      }),
    });

    if (response.ok) {
      return {
        ok: true,
        conversation: (await response.json()) as Conversation,
      };
    }

    // The API's 409 body carries `current`; its 400 and 404 bodies do not. Both
    // shapes are read through one parse so a non-JSON error page (a proxy, a
    // crash) degrades to the status line instead of throwing in the catch below
    // and being reported as a network failure.
    const body = (await response.json().catch(() => null)) as {
      message?: string | string[];
      current?: ConflictState;
    } | null;

    const message = Array.isArray(body?.message)
      ? body.message.join(', ')
      : (body?.message ?? `API responded ${response.status}`);

    return {
      ok: false,
      status: response.status,
      message,
      current: body?.current,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ImportJob {
  id: string;
  filename: string;
  byteSize: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  mode: string;
  batchRows: number;
  rowsRead: number;
  rowsWritten: number;
  rowsSkipped: number;
  resumeRow: number;
  peakRssBytes: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ImportsResult =
  { ok: true; jobs: ImportJob[] } | { ok: false; error: string };

/** This org's import jobs, newest first. Card 15. */
export async function fetchImports(orgId: string): Promise<ImportsResult> {
  const source = `${API_URL}/imports`;
  const requestId = await getRequestId();

  try {
    const { response } = await callApi(source, requestId, {
      headers: { 'x-org-id': orgId },
    });
    if (!response.ok)
      return { ok: false, error: `API responded ${response.status}` };
    return { ok: true, jobs: (await response.json()) as ImportJob[] };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type UploadResult =
  { ok: true; job: ImportJob } | { ok: false; status: number; message: string };

/**
 * Hand a CSV to the API. Card 15.
 *
 * `body` is a web `ReadableStream`, not a string or a Buffer, and `duplex:
 * 'half'` is what undici requires before it will send one. That combination is
 * the whole reason this is a Route Handler rather than a Server Action: Next
 * buffers a Server Action's body and caps it at `serverActions.bodySizeLimit`,
 * default 1MB, so the streaming import would have a 200MB bug one tier above
 * the code that fixed it.
 *
 * `duplex` is missing from the DOM `RequestInit` type, hence the cast. It is
 * part of the fetch standard and Node implements it.
 */
export async function uploadImport(params: {
  orgId: string;
  filename: string;
  body: ReadableStream<Uint8Array>;
}): Promise<UploadResult> {
  const source = `${API_URL}/imports`;
  const requestId = await getRequestId();

  try {
    const { response } = await callApi(source, requestId, {
      method: 'POST',
      headers: {
        'x-org-id': params.orgId,
        'x-filename': params.filename,
        'content-type': 'text/csv',
      },
      body: params.body,
      duplex: 'half',
    } as RequestInit);

    if (response.ok) return { ok: true, job: (await response.json()) as ImportJob }; // prettier-ignore

    const body = (await response.json().catch(() => null)) as {
      message?: string | string[];
    } | null;

    return {
      ok: false,
      status: response.status,
      message: Array.isArray(body?.message)
        ? body.message.join(', ')
        : (body?.message ?? `API responded ${response.status}`),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
