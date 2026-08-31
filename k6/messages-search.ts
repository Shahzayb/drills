import {
  BASE_URL,
  PAGE_SIZE,
  Q,
  request,
  scenario,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

const url = `${BASE_URL}/messages/search?q=${encodeURIComponent(Q)}&limit=${PAGE_SIZE}`;

export const options = scenario();

export default function (): void {
  request(url);
}

export function handleSummary(data: SummaryData) {
  return summary(data, {
    params: `q=${Q} limit=${PAGE_SIZE}`,
    columns: [Q, PAGE_SIZE],
  });
}
