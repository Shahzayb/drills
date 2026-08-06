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
