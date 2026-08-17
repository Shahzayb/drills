/**
 * How LoggingInterceptor reports what src/observability/request-context.ts
 * counted. Read once at module load, same reasoning as TRACING_ENABLED — a
 * deployment-time switch, not a per-request one.
 *
 * - `off`   — no counting, no tap() chain unless debug logging also needs
 *             one. The exact code path drill 06 measured, and therefore a
 *             real arm for what this counter itself costs.
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
