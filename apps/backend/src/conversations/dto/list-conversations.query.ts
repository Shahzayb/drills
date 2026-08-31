import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const DEFAULT_PAGE_SIZE = 50;

export const MAX_PAGE_SIZE = 100;

export const STATUSES = ['open', 'closed'] as const;

export type Status = (typeof STATUSES)[number];

export const SORT_COLUMNS = {
  updated_at: 'updated_at',
  created_at: 'created_at',
} as const;

export type SortKey = keyof typeof SORT_COLUMNS;

export const PAGING_MODES = ['offset', 'keyset'] as const;

export type PagingMode = (typeof PAGING_MODES)[number];

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,512}$/;

export class ListConversationsQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;

  @IsIn(Object.keys(SORT_COLUMNS))
  sort: SortKey = 'updated_at';

  @IsIn(PAGING_MODES)
  paging: PagingMode = 'offset';

  @IsOptional()
  @Matches(CURSOR_PATTERN, {
    message: 'cursor must be a base64url string of 8-512 characters',
  })
  cursor?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: Status;

  @IsOptional()
  @IsISO8601()
  updatedFrom?: string;

  @IsOptional()
  @IsISO8601()
  updatedTo?: string;
}
