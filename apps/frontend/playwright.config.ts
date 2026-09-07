import { defineConfig, devices } from '@playwright/test';

/**
 * The frontend's first test runner. Card 14.
 *
 * `memory-bank/progress.md` has carried "frontend has no test runner" as known
 * issue 1 since drill 10, when load-more was verified by hand and nothing
 * guarded it. Card 14's DONE WHEN is a statement about what a **browser**
 * displays — "the losing client ends up showing the true assignee with a
 * conflict message" — and there is no way to assert that from a backend suite.
 *
 * Runs on the HOST against the running container, which is the same split
 * everything else here follows: `scripts/` and this run on your machine,
 * `apps/backend/db/` and `k6/` run in a container. No `webServer` block for the
 * same reason — `pnpm docker:up` already owns the lifecycle, and a second thing
 * starting Next on 3001 would fight it.
 *
 * One browser. This suite tests a race between two CLIENTS, which Playwright
 * gives us as two browser contexts inside one Chromium; running the whole thing
 * again in Firefox and WebKit would triple the time and re-test React.
 *
 * Setup, once: `pnpm exec playwright install chromium`.
 *
 * See plans/2026-09-08_drill-14-optimistic-locking.md.
 */
export default defineConfig({
  testDir: './e2e',
  // Serial. Every test in here claims the same conversation on purpose, and two
  // of them running at once would race each other rather than the thing under
  // test — a flaky suite that is flaky for the subject it is about is the worst
  // kind to debug.
  fullyParallel: false,
  workers: 1,
  // No retries. A retry on a concurrency test hides exactly the failure it is
  // there to catch.
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
