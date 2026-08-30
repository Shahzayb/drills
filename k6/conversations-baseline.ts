import {
  BASE_URL,
  PAGE,
  PAGE_SIZE,
  request,
  scenario,
  summary,
  type SummaryData,
} from './lib/scenario.ts';

/**
 * Drill 05 baseline — GET /conversations, one page, fixed concurrency.
 *
 * The point of this file is not the load. It is that the *method* is fixed, so
 * the number it prints tonight is comparable to the number it prints in eight
 * weeks. The method is lib/scenario.js and this file does not touch it; what is
 * here is the URL under test and how the run labels itself.
 *
 * A run leaves behind k6/reports/<run>/ — k6's own web dashboard, and the same
 * block this script prints, written next to it as summary.txt. The HTML is
 * gitignored; the summary is the part that gets committed.
 *
 * The filename is load-bearing: ~60 recorded run directories carry it, and the
 * plans cite them by name. It stays `conversations-baseline.ts` for that reason
 * alone. `pnpm load list` is the short way to run it.
 */

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
