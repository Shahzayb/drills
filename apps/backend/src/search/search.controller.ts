import { Controller, Get, Query } from '@nestjs/common';
import { QueryBudget } from '../observability/query-budget.decorator';
import { OrgId } from '../tenancy/org-id.decorator';
import { SearchMessagesQuery } from './dto/search-messages.query';
import { MessageSearchResult, SearchService } from './search.service';

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
}
