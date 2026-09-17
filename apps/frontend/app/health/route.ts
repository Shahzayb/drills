import { fetchInfo } from '@/lib/api';

/**
 * Liveness for the web app: 200 whenever Next is serving.
 *
 * The API's reachability is reported but deliberately does not fail this check.
 * The frontend is still up and able to render its outage state when the API is
 * down, and cascading one dependency's failure into every service above it
 * turns a single outage into three. The API has its own health check for that.
 *
 * No page_render line: Docker probes this every 5s and a liveness check that
 * fills the log is one nobody can read past. proxy.ts already puts the id on
 * the response header, so nothing to do here.
 *
 * Note this reaches the API's /info, not its /health — so the Redis hop is not
 * on this path. Backend /health is the only thing touching Redis so far.
 */
export async function GET() {
  const result = await fetchInfo();

  return Response.json({
    status: 'ok',
    // `development` under `next dev`, `production` under `next start`. Card
    // 17's `pnpm ui:paint` reads it and refuses to report JS bytes from a dev
    // server, whose chunks are unminified and carry the HMR client.
    mode: process.env.NODE_ENV,
    checks: {
      api: result.ok
        ? { status: 'up' }
        : { status: 'down', error: result.error },
    },
  });
}
