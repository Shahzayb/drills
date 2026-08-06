import { fetchInfo } from "@/lib/api";

/**
 * Liveness for the web app: 200 whenever Next is serving.
 *
 * The API's reachability is reported but deliberately does not fail this check.
 * The frontend is still up and able to render its outage state when the API is
 * down, and cascading one dependency's failure into every service above it
 * turns a single outage into three. The API has its own health check for that.
 */
export async function GET() {
  const result = await fetchInfo();

  return Response.json({
    status: "ok",
    checks: {
      api: result.ok
        ? { status: "up" }
        : { status: "down", error: result.error },
    },
  });
}
