import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 50;

// Without a ceiling, `?pageSize=1000000` is a free denial of service: one
// request, one full scan, one enormous body. The ceiling is what turns that
// into a 400 at the edge instead of a slow 200.
export const MAX_PAGE_SIZE = 100;

/**
 * The two values `conversations.status` may hold, matching migration 001's
 * CHECK constraint. Exported so the update DTO spells the union once rather
 * than twice — two copies of a domain's values drift the moment a third is
 * added.
 */
export const STATUSES = ['open', 'closed'] as const;

export type Status = (typeof STATUSES)[number];

/**
 * The only columns `sort` may name. An ORDER BY column cannot be a bind
 * parameter — `ORDER BY $1` sorts by a constant string, silently and without
 * error — so the name has to be interpolated into the SQL. This map is the only
 * thing between the caller and injection: the request supplies a *key*, the
 * query gets the *value*, and an unknown key never reaches the query builder.
 */
export const SORT_COLUMNS = {
  updated_at: 'updated_at',
  created_at: 'created_at',
} as const;

export type SortKey = keyof typeof SORT_COLUMNS;

/**
 * Validated by the global ValidationPipe before the handler runs, so the
 * controller and the service only ever see values that are already in range.
 *
 * Field initialisers are the defaults: class-transformer builds the instance
 * with `new`, so a key absent from the query string keeps the value here.
 */
export class ListConversationsQuery {
  // @Type is required and is not decoration: query strings are all strings, so
  // without it `page` arrives as '3' and @IsInt rejects every request.
  // `enableImplicitConversion` would do this globally, but it coerces in places
  // you did not ask for; per-field is explicit and boring.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;

  @IsIn(Object.keys(SORT_COLUMNS))
  sort: SortKey = 'updated_at';

  // The three below are optional with no default, and that is the drill: "no
  // status filter" and "status=open" have to be two different queries, or card
  // 09 has nothing to compare. @IsOptional() comes first so an absent key is
  // skipped rather than failing the validator below it.
  //
  // See plans/2026-08-25_drill-09-index-selectivity.md.
  @IsOptional()
  @IsIn(STATUSES)
  status?: Status;

  // Strings, handed to Postgres and cast in SQL with `::timestamptz`. Not
  // `@Type(() => Date)`: a JS Date would be re-serialised by `pg` through the
  // driver's own formatting, which is a timezone conversion nobody asked for in
  // the middle of a filter whose whole job is to be exact.
  //
  // @IsISO8601 accepts `2026-08-01` (what <input type="date"> submits) as well
  // as a full `2026-08-01T12:00:00Z`. A bare date reads as midnight in the
  // *server's* timezone, not the reader's — the same honesty the page already
  // applies by printing raw ISO timestamps instead of toLocaleString().
  @IsOptional()
  @IsISO8601()
  updatedFrom?: string;

  @IsOptional()
  @IsISO8601()
  updatedTo?: string;
}
