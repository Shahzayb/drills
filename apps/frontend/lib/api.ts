// The API is reached by Compose service name, not localhost. This only works
// from the Next *server* — a client component would have to use the published
// host port instead, because the browser is not on the Compose network.
const API_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3002';

export interface Info {
  postgres: {
    version: string;
    serverTime: string;
    poolStats: { total: number; idle: number; waiting: number; max: number };
  };
}

export type InfoResult =
  | { ok: true; info: Info; source: string }
  | { ok: false; error: string; source: string };

/**
 * Next 16 does not cache fetch by default, so this runs per request without
 * any `cache: 'no-store'` opt-out. Failure is returned rather than thrown so
 * the page can render the outage instead of collapsing into an error boundary.
 */
export async function fetchInfo(): Promise<InfoResult> {
  const source = `${API_URL}/info`;

  try {
    const response = await fetch(source);
    if (!response.ok) {
      return { ok: false, error: `API responded ${response.status}`, source };
    }
    return { ok: true, info: (await response.json()) as Info, source };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
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

export type ConversationsResult =
  | { ok: true; page: ConversationPage; source: string }
  | { ok: false; error: string; status?: number; source: string };

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

  try {
    const response = await fetch(source, {
      headers: { "x-org-id": params.orgId },
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
      };
    }

    return {
      ok: true,
      page: (await response.json()) as ConversationPage,
      source,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      source,
    };
  }
}
