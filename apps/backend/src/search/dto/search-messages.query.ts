import { Type } from 'class-transformer';
import { IsInt, Length, Max, Min } from 'class-validator';

export const DEFAULT_SEARCH_LIMIT = 20;

export const MAX_SEARCH_LIMIT = 100;

export const MIN_TERM_LENGTH = 2;
export const MAX_TERM_LENGTH = 100;

export class SearchMessagesQuery {
  @Length(MIN_TERM_LENGTH, MAX_TERM_LENGTH)
  q!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SEARCH_LIMIT)
  limit: number = DEFAULT_SEARCH_LIMIT;
}
