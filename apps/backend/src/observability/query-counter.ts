/**
 * How LoggingInterceptor reports what src/observability/request-context.ts
 * counted. Read once at module load, same reasoning as TRACING_ENABLED — a
 * deployment-time switch, not a per-request one.
 *
 * - `off`   — no increments (request-context.ts checks this mode, not just
 *             this module's readers) and no tap() chain unless debug logging
 *             also needs one. Drill 06's code path, and therefore a real arm
 *             for what this counter costs. It has to gate the increments to be
 *             that: gating only the reporting would leave every statement
 *             paying an AsyncLocalStorage lookup and make the arm measure the
 *             interceptor alone. It shipped that way and the recorded number
 *             was wrong until re-measured — see the plan file's Results.
 * - `on`    — count, and warn past budget. Default: a budget nobody is
 *             watching is not a budget.
 * - `header` — also set x-query-count on the response. Off by default because
 *             a response header is API surface; apps/backend/package.json's
 *             test:e2e script sets it so the e2e suite always has it.
 */
export type QueryCounterMode = 'off' | 'on' | 'header';

const raw = process.env.QUERY_COUNTER ?? 'on';
export const QUERY_COUNTER_MODE: QueryCounterMode =
  raw === 'off' || raw === 'header' ? raw : 'on';

/** Set only when QUERY_COUNTER_MODE is 'header'. Not on by default in
 *  production — see the mode's own comment above. */
export const QUERY_COUNT_HEADER = 'x-query-count';
