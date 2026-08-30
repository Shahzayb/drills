import {
  BASE_URL,
  PAGE_SIZE,
  Q,
  options,
  request,
  summary,
} from './lib/scenario.js';

/**
 * Drill 11 — GET /messages/search under load.
 *
 * Same method as conversations-baseline.js, and now literally so: both import
 * lib/scenario.js. The only reason this is a separate file rather than a knob
 * on the baseline is that the baseline's recorded runs must keep measuring the
 * same URL. See plans/2026-08-13_drill-05-load-test-baseline.md.
 *
 * Which arm answers is not set here. It is `SEARCH_STRATEGY` on the *server*, so
 * an A/B is two runs with a `docker compose up -d nest_server` between them:
 *
 *   SEARCH_STRATEGY=like docker compose up -d nest_server
 *   pnpm load search --name like --q export
 *   docker compose up -d nest_server
 *   pnpm load search --name fts --q export
 *
 * Q is the term, and it changes the measurement more than any other knob: a 4%
 * selective term and a 0.05% one are two different queries wearing one URL.
 * It is NOT in the report directory name — a search term can be any text, and a
 * filename is a filename — so the summary prints it instead.
 */

// PAGE_SIZE rather than a LIMIT of its own, so one runner knob feeds both
// scripts and the report directory name keeps meaning what it says.
const url = `${BASE_URL}/messages/search?q=${encodeURIComponent(Q)}&limit=${PAGE_SIZE}`;

export { options };

export default function () {
  request(url);
}

export function handleSummary(data) {
  return summary(data, {
    params: `q=${Q} limit=${PAGE_SIZE}`,
    columns: [Q, PAGE_SIZE],
  });
}
