export type QueryCounterMode = 'off' | 'on' | 'header';

const raw = process.env.QUERY_COUNTER ?? 'on';
export const QUERY_COUNTER_MODE: QueryCounterMode =
  raw === 'off' || raw === 'header' ? raw : 'on';

export const QUERY_COUNT_HEADER = 'x-query-count';
