import { expect, test, type Page } from '@playwright/test';

/**
 * Card 17's DONE WHEN as a test: the list is on screen while the slow widget
 * is still being computed, and the widget then arrives without a navigation.
 *
 * `waitUntil: 'commit'` is what makes this a test of streaming rather than of
 * the finished page. Playwright's default waits for `load`, and in a streamed
 * document `load` fires after the LAST chunk — by which point the fallback has
 * already been swapped out and there is nothing left to observe. Committing
 * on the first byte hands control back while the server is still writing.
 *
 * Org 1 on purpose. The aggregate takes seconds there, which is the window the
 * middle three assertions need. On the tail org the widget lands in ~250ms and
 * the fallback can be gone before the first locator resolves — a flake that
 * would be about the fixture, not the feature.
 *
 * `E2E_STATS=blocking pnpm test:ui` is the required red run. A blocking
 * document never contains the fallback, so the second assertion times out —
 * which is the proof the arm switch switches. Same shape as `ASSIGN=lww`.
 *
 * See plans/2026-09-17_drill-17-streaming-inbox-suspense.md.
 */

const ORG = process.env.E2E_ORG_ID ?? '1';
const STATS = process.env.E2E_STATS ?? 'stream';

/** Same trick as assign-conflict.spec.ts: a value on `window` survives a soft
 *  update and not a full document load. */
const markDocument = (page: Page, token: string) =>
  page.evaluate((value) => {
    (window as unknown as Record<string, string>).__drill17 = value;
  }, token);

const documentMark = (page: Page) =>
  page.evaluate(
    () => (window as unknown as Record<string, string>).__drill17 ?? null,
  );

test.describe('the inbox streams', () => {
  test('the list is visible before the stats widget has been computed', async ({
    page,
  }) => {
    await page.goto(`/conversations?org=${ORG}&pageSize=25&stats=${STATS}`, {
      waitUntil: 'commit',
    });

    const rows = page.locator('[data-conversation]');
    const fallback = page.locator('[data-stats-fallback]');
    const widget = page.locator('[data-stats]');

    // The shell: the table is on screen...
    await expect(rows.first()).toBeVisible();
    // ...and where the widget will go, there is a placeholder — not the
    // widget. On the blocking arm this is the line that fails: the document
    // never contained a fallback, because the server waited.
    await expect(fallback).toBeVisible();
    await expect(widget).toHaveCount(0);

    await markDocument(page, 'streamed');

    // Then the widget arrives. Thirty seconds is generous for a query that
    // takes three to six on this laptop; the point is that it is LATER than
    // the table, not how much later.
    await expect(widget).toBeVisible({ timeout: 30_000 });
    await expect(widget).toHaveAttribute('data-stats', 'ready');
    await expect(fallback).toHaveCount(0);

    // And it got there by the same response, not by a reload or a refetch.
    expect(await documentMark(page)).toBe('streamed');
  });
});
