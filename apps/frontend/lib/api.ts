import { logger, since } from './logger';
import { getRequestId } from './request-context';
import { REQUEST_ID_HEADER } from './request-id';
import { injectTraceContext } from './trace';

// The API is reached by Compose service name, not localhost. This only works
// from the Next *server* — a client component would have to use the published
// host port instead, because the browser is not on the Compose network.
const API_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3002';

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
 */
async function callApi(
  url: string,
  requestId: string,
  init?: RequestInit,
): Promise<{ response: Response; durMs: number }> {
  const startedAt = performance.now();

  const record = (status: number | null) => {
    const durMs = since(startedAt);
    logger.debug({ rid: requestId, url, status, durMs }, 'upstream_fetch');
    return durMs;
  };

  // Headers, not a spread: RequestInit.headers may legitimately be a Headers
  // instance or an array of pairs, and spreading either silently yields {} —
  // dropping every header without a word.
  const headers = new Headers(init?.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  // The standard's version of the line above, and the two are not redundant.
  // x-request-id is ours and carries a flat, human-readable id. `traceparent`
  // is W3C and carries trace id *plus this span's id*, which is what makes the
  // API's spans children of this render instead of a second, unrelated trace.
  // Nothing on the Nest side reads it explicitly — instrumentation-http does.
  injectTraceContext(headers);

  try {
    const response = await fetch(url, { ...init, headers });
    return { response, durMs: record(response.status) };
  } catch (error) {
    throw new UpstreamError(error, record(null));
  }
}

export interface Info {
  postgres: {
    version: string;
    serverTime: string;
    poolStats: { total: number; idle: number; waiting: number; max: number };
  };
}

export type InfoResult = (
  { ok: true; info: Info } | { ok: false; error: string }
) & { source: string; requestId: string; durMs: number };

/**
 * Next 16 does not cache fetch by default, so this runs per request without
 * any `cache: 'no-store'` opt-out. Failure is returned rather than thrown so
 * the page can render the outage instead of collapsing into an error boundary.
 */
export async function fetchInfo(): Promise<InfoResult> {
  const source = `${API_URL}/info`;
  const requestId = await getRequestId();

  try {
    const { response, durMs } = await callApi(source, requestId);
    if (!response.ok) {
      return {
        ok: false,
        error: `API responded ${response.status}`,
        source,
        requestId,
        durMs,
      };
    }
    return {
      ok: true,
      info: (await response.json()) as Info,
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
      // The real duration, not 0. A connect timeout is 2s of upstream time, and
      // reporting it as zero would charge it to Next's render in the gap table.
      durMs: error instanceof UpstreamError ? error.durMs : 0,
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
  tags: Tag[];
  createdAt: string;
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
) & { source: string; requestId: string; durMs: number };

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
    const { response, durMs } = await callApi(source, requestId, {
      headers: { 'x-org-id': params.orgId },
    });

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
      };
    }

    return {
      ok: true,
      page: (await response.json()) as
        ConversationPage | ConversationCursorPage,
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
      // The real duration, not 0. A connect timeout is 2s of upstream time, and
      // reporting it as zero would charge it to Next's render in the gap table.
      durMs: error instanceof UpstreamError ? error.durMs : 0,
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
