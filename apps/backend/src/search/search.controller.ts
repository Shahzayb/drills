import { Controller, Get, Query } from '@nestjs/common';
import { QueryBudget } from '../observability/query-budget.decorator';
import { OrgId } from '../tenancy/org-id.decorator';
import { SearchMessagesQuery } from './dto/search-messages.query';
import { MessageSearchResult, SearchService } from './search.service';

@Controller('messages')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('search')
  @QueryBudget(1)
  searchMessages(
    @OrgId() orgId: string,
    @Query() query: SearchMessagesQuery,
  ): Promise<MessageSearchResult> {
    return this.search.search(orgId, query);
  }
}
