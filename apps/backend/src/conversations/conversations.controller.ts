import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { QueryBudget } from '../observability/query-budget.decorator';
import { OrgId } from '../tenancy/org-id.decorator';
import {
  AgentListItem,
  ConversationCursorPage,
  ConversationPage,
  ConversationsService,
  ConversationSummary,
  MessageListItem,
} from './conversations.service';
import { AssignConversationDto } from './dto/assign-conversation.dto';
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

  // Card 08's budget: list() runs 3 statements in the batched strategy
  // (list, count, tags) and this is what the metadata has to sit on — see the
  // note on ConversationsService.list() for why the service method itself is
  // the wrong place.
  //
  // Card 10's keyset arm runs 2 (list, tags) — it has no count. The budget
  // stays 3: it is a ceiling on the worst arm, and lowering it would make the
  // offset arm, which is still supported, breach on every request.
  @Get()
  @QueryBudget(3)
  list(
    @OrgId() orgId: string,
    @Query() query: ListConversationsQuery,
  ): Promise<ConversationPage | ConversationCursorPage> {
    return this.conversations.list(orgId, query);
  }

  /**
   * DECLARED BEFORE `@Get(':id')`, and that is not tidiness.
   *
   * Nest matches routes in declaration order, so this below `:id` would never
   * be reached — `agents` would bind as the id parameter, `ParseUUIDPipe` would
   * reject it, and the route would answer 400 for a path that exists. A 404
   * would at least read as missing; a 400 reads as your fault.
   */
  @Get('agents')
  agents(@OrgId() orgId: string): Promise<AgentListItem[]> {
    return this.conversations.listAgents(orgId);
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

  /**
   * The claim. Card 14.
   *
   * A POST and not a PATCH: `PATCH :id` already exists for the status and takes
   * a body of fields to merge, where this is an operation with a precondition
   * and its own failure mode. Keeping them apart means the 409 belongs to one
   * route rather than to "some updates, sometimes".
   *
   * 200 on success, 400 when the optimistic arm gets no version, 404 for a row
   * that is not there or not yours, and **409 with the true current state** when
   * someone else got there first. Not a 500, and not a 200 — the two answers a
   * client cannot do anything sensible with.
   *
   * Two statements at worst, either arm: optimistic is one UPDATE and, when it
   * matches nothing, one re-read to tell 409 from 404; pessimistic is the
   * locking SELECT and one UPDATE. The budget is a ceiling on the worse of the
   * two, the same way list()'s 3 is a ceiling on the offset arm.
   */
  @Post(':id/assign')
  // 200, not Nest's default 201 for a POST. Nothing is created — a claim writes
  // a column on a row that already existed, and 201 would oblige a Location
  // header pointing at something new. Found by measuring: `pnpm db:claim fire`
  // asserts on the 200 and reported *zero* winners on a run where the row had
  // plainly been claimed, because the one success came back as a 201.
  @HttpCode(200)
  @QueryBudget(2)
  assign(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignConversationDto,
  ): Promise<ConversationSummary> {
    return this.conversations.assign(orgId, id, body);
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
