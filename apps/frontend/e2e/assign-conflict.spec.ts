import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

/**
 * Card 14's second half, which is the half the card says people get wrong.
 *
 * Two agents open the inbox. Both see the same unassigned conversation at the
 * same version. Both click "assign to me". The server half already guarantees
 * exactly one of them wins — `apps/backend/test/assign.e2e-spec.ts` proves that
 * and `pnpm db:claim fire` proves it at fifty. What this suite asserts is what
 * the LOSER'S BROWSER does about it:
 *
 *   1. it showed an optimistic update, so it told a lie,
 *   2. it ends up displaying the true assignee — the other agent's name,
 *   3. it says why, and
 *   4. it never reloaded the page to get there.
 *
 * (4) is asserted by pinning a value onto `window` before the click and finding
 * it still there afterwards. A full document load wipes it. That is what "no
 * jarring reload" means as a test rather than as an adjective.
 *
 * The fixture is built through the public API rather than through SQL, because
 * this runs on the host and has no database connection — which is also a useful
 * constraint: everything below is something a client could do.
 *
 * Needs the stack up (`pnpm docker:up`) and browsers installed once
 * (`pnpm exec playwright install chromium`).
 */

const ORG = process.env.E2E_ORG_ID ?? '1';
const API = process.env.E2E_API_URL ?? 'http://localhost:3002';

interface Row {
  id: string;
  version: number;
  assigneeId: string | null;
}

const org = { 'x-org-id': ORG };

/** The newest conversation in the org, released so it is claimable. Releasing
 *  bumps `updated_at`, which under the default `updated_at DESC` sort is also
 *  what puts it at the top of page 1 where the test can find it. */
async function claimableRow(api: APIRequestContext): Promise<Row> {
  const list = await api.get(
    `${API}/conversations?paging=keyset&pageSize=1&sort=updated_at`,
    { headers: org },
  );
  expect(list.ok()).toBeTruthy();
  const [row] = ((await list.json()) as { items: Row[] }).items;
  expect(
    row,
    'the org needs at least one conversation — run pnpm db:seed',
  ).toBeDefined();

  const released = await api.post(`${API}/conversations/${row.id}/assign`, {
    headers: org,
    data: { assigneeId: null, version: row.version },
  });
  expect(released.ok()).toBeTruthy();
  return (await released.json()) as Row;
}

async function agents(api: APIRequestContext) {
  const response = await api.get(`${API}/conversations/agents`, {
    headers: org,
  });
  expect(response.ok()).toBeTruthy();
  const list = (await response.json()) as { id: string; name: string }[];
  expect(list.length, 'the org needs at least two agents').toBeGreaterThan(1);
  return list;
}

/** Marks this document, so a later assertion can tell a soft update from a
 *  navigation. Cleared by any full load, kept by every re-render. */
const markDocument = (page: Page, token: string) =>
  page.evaluate((value) => {
    (window as unknown as Record<string, string>).__drill14 = value;
  }, token);

const documentMark = (page: Page) =>
  page.evaluate(
    () => (window as unknown as Record<string, string>).__drill14 ?? null,
  );

test.describe('two agents claim the same ticket', () => {
  test('the loser converges on the true assignee and is told why, without a reload', async ({
    browser,
    request,
  }) => {
    const people = await agents(request);
    const [alice, bob] = people;
    const row = await claimableRow(request);

    // Two contexts, not two tabs: separate storage, the way two people are.
    const first = await browser.newContext();
    const second = await browser.newContext();
    const alicePage = await first.newPage();
    const bobPage = await second.newPage();

    const url = (me: string) =>
      `/conversations?org=${ORG}&pageSize=25&me=${me}`;

    // BOTH loaded before EITHER clicks. That is the scenario: two inboxes
    // rendered from the same version, minutes of human time apart from the
    // click that follows.
    await alicePage.goto(url(alice.id));
    await bobPage.goto(url(bob.id));

    const aliceRow = alicePage.locator(`[data-assignee="${row.id}"]`);
    const bobRow = bobPage.locator(`[data-assignee="${row.id}"]`);
    await expect(aliceRow).toHaveText('—');
    await expect(bobRow).toHaveText('—');

    // Both pages are showing the same version, which is the precondition the
    // whole card rests on. Asserted rather than assumed: if the two renders
    // disagreed, the "conflict" below would be a stale page, not a race.
    const version = alicePage.locator(`[data-version="${row.id}"]`);
    await expect(version).toHaveText(String(row.version));
    await expect(bobPage.locator(`[data-version="${row.id}"]`)).toHaveText(
      String(row.version),
    );

    await markDocument(alicePage, 'alice');
    await markDocument(bobPage, 'bob');

    // --- Alice wins ---------------------------------------------------------
    await alicePage.click(`[data-claim="${row.id}"]`);
    await expect(aliceRow).toHaveText(alice.name);
    await expect(
      alicePage.locator(`[data-conflict="${row.id}"]`),
      'the winner is told nothing, because nothing went wrong',
    ).toHaveCount(0);

    // --- Bob loses ----------------------------------------------------------
    await bobPage.click(`[data-claim="${row.id}"]`);

    const conflict = bobPage.locator(`[data-conflict="${row.id}"]`);
    await expect(conflict).toBeVisible();
    // It names the winner. "Something went wrong" would be true and useless:
    // the one thing the loser needs is who to go and talk to.
    await expect(conflict).toContainText(alice.name);

    // The card's DONE WHEN, in one assertion: the losing client displays the
    // TRUE assignee. Not "reverts to unassigned", not "keeps Bob's name with a
    // warning next to it" — Alice's name, which the browser learned from a
    // server render rather than from the 409 body.
    await expect(bobRow).toHaveText(alice.name);
    await expect(bobPage.locator(`[data-version="${row.id}"]`)).toHaveText(
      String(row.version + 1),
    );

    // And it got there without a navigation.
    expect(await documentMark(bobPage)).toBe('bob');
    expect(await documentMark(alicePage)).toBe('alice');

    await first.close();
    await second.close();
  });

  test('a claim that wins updates the row and leaves no conflict behind', async ({
    page,
    request,
  }) => {
    const [alice] = await agents(request);
    const row = await claimableRow(request);

    await page.goto(`/conversations?org=${ORG}&pageSize=25&me=${alice.id}`);
    await markDocument(page, 'solo');

    await page.click(`[data-claim="${row.id}"]`);

    await expect(page.locator(`[data-assignee="${row.id}"]`)).toHaveText(
      alice.name,
    );
    await expect(page.locator(`[data-version="${row.id}"]`)).toHaveText(
      String(row.version + 1),
    );
    await expect(page.locator(`[data-conflict="${row.id}"]`)).toHaveCount(0);
    // Same soft-update guarantee on the happy path. `refresh()` is called on
    // both paths, so if it navigated it would navigate here too.
    expect(await documentMark(page)).toBe('solo');
  });

  test('with no agent selected there is nothing to claim with', async ({
    page,
  }) => {
    await page.goto(`/conversations?org=${ORG}&pageSize=5`);

    await expect(page.locator('[data-claim]')).toHaveCount(0);
    await expect(page.getByText('pick one to enable')).toBeVisible();
  });
});
