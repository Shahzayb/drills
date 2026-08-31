import { logger, since } from './logger';
import { getRequestId } from './request-context';
import { REQUEST_ID_HEADER } from './request-id';
import { injectTraceContext } from './trace';

const API_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3002';

class UpstreamError extends Error {
  constructor(
    readonly cause: unknown,
    readonly durMs: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

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

  const headers = new Headers(init?.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
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

export interface ConversationCursorPage {
  items: Conversation[];
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export const isCursorPage = (
  page: ConversationPage | ConversationCursorPage,
): page is ConversationCursorPage => !('total' in page);

export type ConversationsResult = (
  | { ok: true; page: ConversationPage | ConversationCursorPage }
  | { ok: false; error: string; status?: number }
) & { source: string; requestId: string; durMs: number };

export async function fetchConversations(params: {
  orgId: string;
  page: string;
  pageSize: string;
  sort: string;
  status?: string;
  updatedFrom?: string;
  updatedTo?: string;
  paging?: string;
  cursor?: string;
}): Promise<ConversationsResult> {
  const query = new URLSearchParams({
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
  });

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
