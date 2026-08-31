import {
  BASE_URL,
  PAGE,
  PAGE_SIZE,
  request,
  scenario,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

const url = `${BASE_URL}/conversations?page=${PAGE}&pageSize=${PAGE_SIZE}`;

export const options = scenario();

export default function (): void {
  request(url);
}

export function handleSummary(data: SummaryData) {
  return summary(data, {
    params: `page=${PAGE} pageSize=${PAGE_SIZE}`,
    columns: [PAGE, PAGE_SIZE],
  });
}
