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
import { OrgId } from '../tenancy/org-id.decorator';
import {
  ConversationListItem,
  ConversationPage,
  ConversationsService,
  MessageListItem,
} from './conversations.service';
import { ListConversationsQuery } from './dto/list-conversations.query';
import { UpdateConversationDto } from './dto/update-conversation.dto';

/**
 * One org's conversations.
 *
 * The controller is thin by design: it says what the route is, where the org
 * comes from, and what shape the query has. Everything it does before calling
 * the service is done by decorators, which is the point of them — the handler
 * body never contains a validation branch.
 *
 * `ParseUUIDPipe` on every `:id` is not tidiness. Without it a non-uuid reaches
 * Postgres, which raises `22P02 invalid input syntax for type uuid`, and the
 * caller gets a 500 that distinguishes malformed from missing. A 400 here and a
 * 404 below are the only two answers this route should ever give.
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

  @Get(':id')
  get(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationListItem> {
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
  ): Promise<ConversationListItem> {
    return this.conversations.updateStatus(orgId, id, body.status);
  }

  @Delete(':id')
  // 204: the response carries nothing, and a 200 with an empty body invites a
  // client to parse it.
  @HttpCode(204)
  remove(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.conversations.remove(orgId, id);
  }
}
