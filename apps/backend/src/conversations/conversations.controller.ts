import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { QueryBudget } from '../observability/query-budget.decorator';
import { OrgId } from '../tenancy/org-id.decorator';
import {
  ConversationCursorPage,
  ConversationPage,
  ConversationsService,
  ConversationSummary,
  MessageListItem,
} from './conversations.service';
import { ListConversationsQuery } from './dto/list-conversations.query';
import { UpdateConversationDto } from './dto/update-conversation.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @QueryBudget(3)
  list(
    @OrgId() orgId: string,
    @Query() query: ListConversationsQuery,
  ): Promise<ConversationPage | ConversationCursorPage> {
    return this.conversations.list(orgId, query);
  }

  @Get(':id')
  get(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationSummary> {
    return this.conversations.get(orgId, id);
  }

  @Get(':id/messages')
  messages(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageListItem[]> {
    return this.conversations.listMessages(orgId, id);
  }

  @Patch(':id')
  update(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateConversationDto,
  ): Promise<ConversationSummary> {
    return this.conversations.updateStatus(orgId, id, body.status);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.conversations.remove(orgId, id);
  }
}
