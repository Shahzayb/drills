import { IsIn } from 'class-validator';

/**
 * The only field this endpoint may change. `status` and nothing else — the
 * global ValidationPipe runs with `forbidNonWhitelisted`, so a body carrying
 * `orgId` is a 400 rather than a silently ignored property.
 *
 * That matters more than it looks: an endpoint that accepts an org id in the
 * body is an endpoint where the caller names their own tenant on a *write*.
 * The org comes from the header decorator or it does not come at all.
 */
export class UpdateConversationDto {
  @IsIn(['open', 'closed'])
  status!: 'open' | 'closed';
}
