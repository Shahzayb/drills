import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { QueryBudget } from '../observability/query-budget.decorator';
import { SERVED_AT_HEADER } from '../observability/request-context';
import { OrgId } from '../tenancy/org-id.decorator';
import { SearchMessagesQuery } from './dto/search-messages.query';
import {
  MessageSearchResult,
  MessageStats,
  SearchService,
  STATS_CACHE_HEADER,
} from './search.service';

/**
 * Search over one org's message bodies.
 *
 * Its own route rather than a `q` parameter on `GET /conversations`, and that is
 * a decision rather than convenience. The list endpoint's keyset cursor carries
 * a fingerprint of `sort|status|updatedFrom|updatedTo`; a search term added
 * there without also being added to the fingerprint lets a cursor replay across
 * a different result set and return wrong rows with a 200. Search over
 * `messages` is also a different table, a different index and a different
 * measurement from paging over `conversations`.
 *
 * See plans/2026-08-29_drill-11-full-text-search.md.
 */
@Controller('messages')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  // One statement, both arms — there is no count and no second round trip, so
  // unlike the list endpoint's budget of 3 this one is a floor as well as a
  // ceiling. It goes red the moment anyone adds a total.
  @Get('search')
  @QueryBudget(1)
  searchMessages(
    @OrgId() orgId: string,
    @Query() query: SearchMessagesQuery,
  ): Promise<MessageSearchResult> {
    return this.search.search(orgId, query);
  }

  /**
   * Card 17's widget. One aggregate over the org's messages, one statement,
   * and slow for the whale by design — see SearchService.stats(). A recompute
   * costs exactly one statement and a cache hit costs none; a second statement
   * here would be a second scan of ten million rows.
   *
   * A cached answer carries the time Postgres computed it in `x-served-at`, so
   * drill 18's "predates the question" predicate reports its true age.
   */
  @Get('stats')
  @QueryBudget(1)
  async stats(
    @OrgId() orgId: string,
    @Headers('cache-control') cacheControl: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MessageStats> {
    const answer = await this.search.stats(
      orgId,
      /\bno-cache\b/i.test(cacheControl ?? ''),
    );
    response.setHeader(STATS_CACHE_HEADER, answer.source);
    response.setHeader(
      SERVED_AT_HEADER,
      new Date(answer.computedAt).toISOString(),
    );
    return answer.stats;
  }
}
