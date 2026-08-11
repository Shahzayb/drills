import { Controller, Get, Query } from '@nestjs/common';
import { OrgId } from '../tenancy/org-id.decorator';
import {
  ConversationPage,
  ConversationsService,
} from './conversations.service';
import { ListConversationsQuery } from './dto/list-conversations.query';

/**
 * `GET /conversations` — one page of one org's conversations.
 *
 * The controller is thin by design: it says what the route is, where the org
 * comes from, and what shape the query has. Everything it does before calling
 * the service is done by decorators, which is the point of them — the handler
 * body never contains a validation branch.
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query() query: ListConversationsQuery,
  ): Promise<ConversationPage> {
    return this.conversations.list(orgId, query);
  }
}
