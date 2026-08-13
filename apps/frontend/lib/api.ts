import { logger, since } from './logger';
import { getRequestId } from './request-context';
import { REQUEST_ID_HEADER } from './request-id';

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

export interface Conversation {
  id: string;
  status: string;
  assigneeId: string | null;
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

export type ConversationsResult = (
  | { ok: true; page: ConversationPage }
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
 * is the honest behaviour, and the answer drill 03's writeup asks for.
 */
export async function fetchConversations(params: {
  orgId: string;
  page: string;
  pageSize: string;
  sort: string;
}): Promise<ConversationsResult> {
  const query = new URLSearchParams({
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
  });
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
      page: (await response.json()) as ConversationPage,
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
