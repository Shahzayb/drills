import { IsInt, IsOptional, Matches, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Who is claiming this conversation, and what they believed about it when they
 * clicked.
 *
 * `assigneeId` is a membership id, and it arrives as a STRING. `memberships.id`
 * is a bigserial, `pg` hands bigints back as strings because one can exceed
 * Number.MAX_SAFE_INTEGER, and `ConversationSummary.assigneeId` already goes out
 * as a string for that reason. Taking it in as a number here would put a silent
 * rounding step on the way in that nothing on the way out has.
 *
 * `null` is the release: "nobody owns this now". Distinct from an absent field,
 * which is why `@IsOptional()` is wrong for it — `@ValidateIf` is what allows
 * an explicit null through the digits check while still rejecting an omitted
 * key. (This is the narrow case `@ValidateIf` is actually for. The one
 * `ListConversationsQuery` rejects it for is different: there it would have
 * skipped validators on a value the request supplied, which is the opposite.)
 *
 * `version` is optional HERE and required by the service on the `optimistic`
 * arm. The requirement is a property of the arm, and an arm is a module constant
 * resolved at load — a decorator cannot read one without making the DTO
 * unreadable, so the service raises the 400 instead and says which arm asked.
 */
export class AssignConversationDto {
  // Digits only, and no upper bound: a bigserial has no fixed width in text and
  // Postgres will reject an out-of-range one with 22003. What this stops is a
  // non-numeric string reaching `::bigint` and coming back as a 500.
  @ValidateIf((_, value) => value !== null)
  @Matches(/^[1-9][0-9]{0,18}$/, {
    message: 'assigneeId must be a positive integer id, or null to release',
  })
  assigneeId!: string | null;

  // @Type is required for the same reason ListConversationsQuery needs one: a
  // JSON body does give us a number, but the e2e suite and every hand-rolled
  // curl send it either way, and coercing here costs nothing.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}
