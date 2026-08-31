import { SetMetadata } from '@nestjs/common';

export const QUERY_BUDGET_KEY = 'queryBudget';

export const DEFAULT_QUERY_BUDGET = 5;

export const QueryBudget = (budget: number) =>
  SetMetadata(QUERY_BUDGET_KEY, budget);
