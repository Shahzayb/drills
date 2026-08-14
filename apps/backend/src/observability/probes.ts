/**
 * The two endpoints Docker probes every 5 seconds.
 *
 * Its own file because both the logger and the tracer have to agree on it, and
 * the tracer cannot import `logger.options.ts` — that would pull nestjs-pino,
 * and with it `@nestjs/core`, into the process before the SDK has patched
 * anything. See src/tracing.ts.
 *
 * `/info` is here because the *frontend's* `/health` calls it, so excluding
 * only `/health` silences one probe and leaves the noisier one.
 */
export const PROBE_ROUTES = /^\/(health|info)\b/;
