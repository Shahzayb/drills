import { SetMetadata } from '@nestjs/common';

export const QUERY_BUDGET_KEY = 'queryBudget';

/**
 * Applies to every route that declares nothing — which is the whole point.
 * The card's scenario is an N+1 nobody noticed, not one somebody remembered
 * to annotate; a default that only fires on routes somebody thought to guard
 * would miss exactly the case that matters.
 *
 * Every existing conversations endpoint other than `list` fits inside this
 * without an explicit `@QueryBudget` — one or two statements plus the
 * `withOrg` wrapper's control calls, which do not count against it. See
 * src/observability/request-context.ts for the queries/roundTrips split.
 */
export const DEFAULT_QUERY_BUDGET = 5;

/**
 * Declares how many statements (`RequestContext.queries`, not
 * `roundTrips` — the wrapper's BEGIN/set_config/COMMIT are not a "query" in
 * this sense) a route may run through `PostgresService` before
 * `LoggingInterceptor` logs `query_budget_exceeded`.
 *
 * Handler-level metadata, read via `Reflector.getAllAndOverride` so a handler
 * can override a class-level default — neither is used today, but the
 * mechanism is the same one Nest guards and other interceptors already use,
 * not a bespoke one.
 */
export const QueryBudget = (budget: number) =>
  SetMetadata(QUERY_BUDGET_KEY, budget);
