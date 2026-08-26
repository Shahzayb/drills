import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

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
 * Which paging arm runs. `offset` is the default so drill 05's baseline URL
 * (`?page=1&pageSize=20`) and every recorded k6 run keep measuring the same
 * thing — and so the numbered pager, the only way to jump to page 40, does not
 * disappear the day the cursor lands.
 *
 * Both arms stay on one commit, same reasoning as LIST_STRATEGY: an A/B whose
 * arms are two different checkouts measures the checkout. See
 * plans/2026-08-26_drill-10-keyset-pagination.md.
 */
export const PAGING_MODES = ['offset', 'keyset'] as const;

export type PagingMode = (typeof PAGING_MODES)[number];

/** base64url, and long enough for the payload plus a fingerprint. The ceiling
 *  is what keeps a megabyte of base64 away from JSON.parse. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,512}$/;

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

  @IsIn(PAGING_MODES)
  paging: PagingMode = 'offset';

  /**
   * Where the keyset page resumes. Opaque on purpose — see
   * ConversationsService.encodeCursor.
   *
   * The pattern is a shape check, not validation: what the cursor *contains* is
   * the service's business and it raises its own 400s. All this stops is a
   * megabyte of base64 reaching JSON.parse.
   *
   * A cursor sent with `paging=offset` is rejected by `list()`, not here. A
   * `@ValidateIf` would have done the opposite of what it reads like — it
   * *skips* the validators when the condition is false, so the mismatched
   * combination would have been silently accepted and then ignored, which is
   * drill 08's QUERY_COUNTER bug wearing a different hat.
   */
  @IsOptional()
  @Matches(CURSOR_PATTERN, {
    message: 'cursor must be a base64url string of 8-512 characters',
  })
  cursor?: string;

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
