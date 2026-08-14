/**
 * Next's one startup hook: `register` runs once per server instance, before
 * the first request is served. The API's equivalent is `import './tracing'` at
 * the top of main.ts — Next owns its own module graph, so it gives you a
 * callback instead of asking you to win a race with `require`.
 */
export async function register() {
  // register() is called in every runtime, and the SDK is Node-only. The
  // dynamic import (rather than a top-level one) is what keeps @opentelemetry
  // out of the Edge bundle entirely instead of failing when it gets there.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation.node');
  }
}
