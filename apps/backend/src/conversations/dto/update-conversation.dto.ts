import { IsIn } from 'class-validator';
import { STATUSES } from './list-conversations.query';
import type { Status } from './list-conversations.query';

export class UpdateConversationDto {
  @IsIn(STATUSES)
  status!: Status;
}
