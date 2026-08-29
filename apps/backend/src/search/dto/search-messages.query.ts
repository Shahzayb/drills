import { Type } from 'class-transformer';
import { IsInt, Length, Max, Min } from 'class-validator';

export const DEFAULT_SEARCH_LIMIT = 20;

// Same reasoning as MAX_PAGE_SIZE on the list endpoint: without a ceiling,
// `?limit=1000000` is one request that fetches a million heap rows.
export const MAX_SEARCH_LIMIT = 100;

// Two characters is the floor because one is not a search, it is a table scan
// with a `LIMIT`. The ceiling keeps a megabyte of query text away from the
// tsquery parser.
export const MIN_TERM_LENGTH = 2;
export const MAX_TERM_LENGTH = 100;

/**
 * Validated by the global ValidationPipe before the handler runs.
 *
 * `q` is required and has no default. An empty search box submitting `?q=` is a
 * 400, not "every message in the org" — the LIKE arm would answer that with a
 * full scan and a 200.
 */
export class SearchMessagesQuery {
  @Length(MIN_TERM_LENGTH, MAX_TERM_LENGTH)
  q!: string;

  // @Type is required, not decoration: query strings are strings, so without it
  // `limit` arrives as '20' and @IsInt rejects every request.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SEARCH_LIMIT)
  limit: number = DEFAULT_SEARCH_LIMIT;
}
