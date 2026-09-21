import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

/**
 * Card 18: the stale read, reproduced and pinned to a layer.
 *
 * The scenario on the card: an agent changes a status, navigates away, comes
 * back, sees the old one; refresh fixes it. Two tests, because two layers can
 * produce that sentence and they need different evidence:
 *
 *   1. THE DATA CACHE. This browser writes, and every render after the write
 *      still says the old value — the action's own re-render, the list, Back,
 *      and a reload. `E2E_CACHE=cached` is the red run: it fails at the first
 *      render after the write, and the footer says `served: cache` with a rid
 *      that is not this page's. `tagged` (default) and `blanket` pass.
 *      `nostore` is the "disable caching" fix and is expected to pass the
 *      data-cache steps; whether it passes the Back step is prediction 4 of
 *      the plan — the test decides.
 *
 *   2. THE ROUTER CACHE. Someone ELSE writes (the API, with Next's data cache
 *      expired so it is fresh), and this browser presses Back. It sees the old
 *      list and made ZERO requests to get it — the evidence that no server was
 *      asked. A Link click, by contrast, fetches and is fresh. That is the
 *      card's "intermittent": same page, two ways back, two answers. Green on
 *      every arm, because nothing in this repo fixes it (memory-bank known
 *      issue 18: another agent's write needs a subscription).
 *
 * Fixtures write through the API, which cannot reach Next's cache, so every
 * fixture write is followed by `POST /api/revalidate` — the same door any
 * out-of-band writer has to use. `stats=off` keeps the whale's 5GB widget out
 * of a test that is not about it.
 */

const ORG = process.env.E2E_ORG_ID ?? '1';
const API = process.env.E2E_API_URL ?? 'http://localhost:3002';
const CACHE = process.env.E2E_CACHE ?? 'tagged';

const org = { 'x-org-id': ORG };

interface Row {
  id: string;
  status: string;
}

/** The newest conversation in the org, set to `open` through the API, with
 *  Next told about it. Setting the status bumps `updated_at`, which puts the
 *  row at the top of page 1 where the test can find it. */
async function openRow(api: APIRequestContext): Promise<Row> {
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
  await setStatus(api, row.id, 'open');
  return { id: row.id, status: 'open' };
}

/** An out-of-band write: the API changes the row, then Next is told to expire
 *  what that write made wrong — with the blanket arm, so the fixture starts
 *  every arm from an empty cache for this org. */
async function setStatus(api: APIRequestContext, id: string, status: string) {
  const patched = await api.patch(`${API}/conversations/${id}`, {
    headers: org,
    data: { status },
  });
  expect(patched.ok()).toBeTruthy();
  const purged = await api.post('/api/revalidate', {
    data: { org: ORG, id, cache: 'blanket' },
  });
  expect(purged.ok()).toBeTruthy();
}

const listUrl = `/conversations?org=${ORG}&pageSize=25&stats=off&cache=${CACHE}`;

/** Records the RSC requests a navigation makes. A client-side transition
 *  that asks the server sends `?_rsc=`; one served from the router's own
 *  cache sends nothing. The list is the evidence, so it is asserted rather
 *  than logged. */
function rscRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.searchParams.has('_rsc')) seen.push(url.pathname);
  });
  return seen;
}

/** What the detail page says about who answered its row fetch, and which
 *  request produced this render — read together so a re-render is never
 *  mistaken for the page before it. */
async function detailEvidence(page: Page) {
  const line = page.locator('[data-fetch="conversation"]');
  return {
    rid: await page.locator('[data-page-rid]').getAttribute('data-page-rid'),
    served: await line.getAttribute('data-served'),
    filledBy: await line.getAttribute('data-rid'),
  };
}

test.describe('a status change is visible everywhere the user looks', () => {
  test(`cache=${CACHE}: after the write, the detail page, the list, Back and reload all say closed`, async ({
    page,
    request,
  }) => {
    const row = await openRow(request);
    const rowStatus = page.locator(`[data-row-status="${row.id}"]`);
    const status = page.locator('[data-conversation-status]');

    await page.goto(listUrl);
    await expect(rowStatus).toHaveText('open');

    // Into the detail page by client-side navigation, the way a user gets
    // there — a Link, not a goto — so the router cache holds the list.
    await page.click(`[data-conversation-link="${row.id}"]`);
    await expect(page).toHaveURL(new RegExp(`/conversations/${row.id}`));
    await expect(status).toHaveText('open');
    const before = await detailEvidence(page);

    // The write. The response to this click IS a render of this page, and
    // the re-render carries the action's own request id — waiting for the id
    // to change is waiting for the re-render, whatever it says.
    await page.click('[data-status-form] button');
    await expect(page.locator('[data-page-rid]')).not.toHaveAttribute(
      'data-page-rid',
      before.rid ?? '',
    );
    const after = await detailEvidence(page);
    test.info().annotations.push({
      type: 'served',
      description:
        `before the write: ${before.served} (rid ${before.filledBy}); ` +
        `the re-render: ${after.served} (filled by ${after.filledBy}, page ${after.rid})`,
    });

    // Read your own write. On `cached` this is where it stops: the re-render
    // came from the data cache and still says `open`, and the evidence line
    // names the request that filled the entry rather than this one.
    await expect(
      status,
      `the action re-render must show the write (it was served from ${after.served})`,
    ).toHaveText('closed');

    // Back to the list by Link: a client-side transition that fetches.
    await page.click('[data-inbox-link]');
    await expect(page).toHaveURL(/\/conversations\?/);
    await expect(rowStatus, 'the list after a Link navigation').toHaveText(
      'closed',
    );

    // Back, twice: to the detail page, then to the ORIGINAL list entry — the
    // one rendered before the write. This is the card's sentence. The router
    // reuses what it has for back/forward regardless of stale time; whether
    // the action's revalidation threw that away is what this measures.
    const duringBack = rscRequests(page);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/conversations/${row.id}`));
    await expect(status, 'the detail page on Back').toHaveText('closed');
    const afterFirstBack = duringBack.length;
    await page.goBack();
    await expect(page).toHaveURL(/\/conversations\?/);
    await expect(rowStatus, 'the original list entry on Back').toHaveText(
      'closed',
    );
    test.info().annotations.push({
      type: 'rsc-requests-during-back',
      description:
        `to the detail page: ${duringBack.slice(0, afterFirstBack).join(', ') || 'none'}; ` +
        `to the list: ${duringBack.slice(afterFirstBack).join(', ') || 'none'}`,
    });

    // A reload clears the router cache and nothing else. On `cached` it would
    // still say `open` — the tell that the browser was never the problem.
    await page.reload();
    await expect(rowStatus, 'the list after a reload').toHaveText('closed');
  });
});

test.describe('the layer nobody’s code fixes', () => {
  test(`cache=${CACHE}: another agent’s write is invisible on Back and visible on a Link`, async ({
    page,
    request,
  }) => {
    const row = await openRow(request);
    const rowStatus = page.locator(`[data-row-status="${row.id}"]`);

    await page.goto(listUrl);
    await expect(rowStatus).toHaveText('open');
    await page.click(`[data-conversation-link="${row.id}"]`);
    await expect(page.locator('[data-conversation-status]')).toHaveText('open');

    // Someone else closes it. Next's data cache is expired too, so the only
    // thing left holding `open` anywhere is this browser's router cache.
    await setStatus(request, row.id, 'closed');

    // Back: the list this browser already had. No request, old value.
    const duringBack = rscRequests(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/conversations\?/);
    await expect(
      rowStatus,
      'Back serves the list the router already had',
    ).toHaveText('open');
    expect(
      duringBack,
      'and asked the server for nothing — that is the evidence',
    ).toEqual([]);

    // The same row through a Link: a fetch, and the truth.
    await page.click(`[data-conversation-link="${row.id}"]`);
    await expect(page.locator('[data-conversation-status]')).toHaveText(
      'closed',
    );
    await page.click('[data-inbox-link]');
    await expect(rowStatus, 'a Link navigation fetches').toHaveText('closed');
  });
});
