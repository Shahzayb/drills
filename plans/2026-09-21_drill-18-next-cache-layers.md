# Drill 18 — Make Next serve stale data on purpose

**Status:** planned

Card 18. Prereqs 14 and 17. Builds a stale-data bug behind a switch, instruments the fetch so
the guilty cache layer is observed rather than argued, fixes it with tags, over-revalidates on
purpose, and measures what each arm costs.

## Context

Next 16 App Router, **classic caching model** — `cacheComponents` stays off (`techContext.md`
records it as deliberate; `'use cache'` is a whole-app mode switch and is named in the guide's
10x section, not built). Today no fetch in `apps/frontend/lib/api.ts` is cached, every
navigation on `/conversations` is a plain `<a>` (full document), and the assign Server Action
calls `refresh()` only. So the app has **no stale-data bug**. The drill builds one, on purpose,
with a switch.

Verified against `node_modules/next/dist/` (16.3.0), not training data:

- **Headers are part of the fetch cache key** (`server/lib/incremental-cache/index.js:283-300`).
  Next strips `traceparent`/`tracestate` from it explicitly; our `x-request-id` is NOT stripped,
  so a cached fetch that carries it misses on every request. Load-bearing for the design.
- `updateTag` (Server Action only) expires immediately and marks the action
  `ActionDidRevalidateStaticAndDynamic` → the client evicts its prefetch cache and refetches.
  `refresh()` marks `DynamicOnly` — "doesn't affect cached data" (`spec-extension/revalidate.js`).
  `revalidateTag(tag, 'max')` is SWR and deliberately does **not** re-render the action's own
  response ("so server actions don't pull their own writes"). **Order hazard:** `refresh()`
  after `updateTag()` overwrites the kind — call `updateTag` last, or not `refresh()` at all.
- Client cache: "Pages are not cached by default but are reused during browser back/forward
  navigation. The client cache is cleared on page refresh" (`04-glossary.md`); bfcache entries
  "disregard the stale time" (`client/components/segment-cache/bfcache.js:81`). That is the
  card's exact symptom: navigate away, come back (Back button), old value, refresh fixes it.
- `revalidatePath` = `revalidateTag` on the implicit `_N_T_/path` tag (`revalidate.js:76-90`).

## Decisions

1. **Four arms on one URL parameter, `?cache=`**, default `tagged`. The `?mode=`/`?stats=`
   precedent: one process, interleavable. The Server Actions and the load-more Route Handler
   take the arm as an input, the same stub as `orgId`.

   | arm | fetch | after a status/assign write | shows |
   |---|---|---|---|
   | `nostore` | `cache: 'no-store'`, rid sent | `refresh()` | the "disable caching" fix; Back may still be stale (router cache — prediction 4) |
   | `cached` | `force-cache` + tags | `refresh()` only | **the bug**: stale for everyone, reload does not fix it |
   | `tagged` | `force-cache` + tags | `updateTag(conversation:id)`, `updateTag(org:o:conversations)` | the fix — ships |
   | `blanket` | `force-cache` + tags | `updateTag(org:o)` | over-revalidation: the 5GB stats scan re-runs after every write |

2. **Cache-eligible fetches send no `x-request-id`** (it is in the key); `traceparent` stays
   (Next strips it from the key, so the trace still joins on a miss). A cached response belongs
   to the request that filled it, and the page says so.
3. **The backend adds one header, `x-served-at`** (ISO, ms) in
   `request-context.middleware.ts` beside the `x-request-id` echo. The hit predicate is exact,
   not a threshold: **the answer predates the question** — `servedAt < startedAt` (both
   containers share the Docker VM clock).
4. **The stats widget joins the tag scheme** with a **60s staleness budget** (`revalidate: 60`,
   the stretch). It is the only fetch expensive enough to make the cost comparison mean
   anything (1.3s / 5GB vs ~0). `progress.md` named `GET /messages/stats` as card 19's victim;
   this caches it in **Next's** data cache, card 19 (entitlement cache, server-side) is
   untouched.
5. **The Full Route Cache is excluded by evidence, not built**: both routes read `searchParams`
   → `ƒ (Dynamic)` in the `next build` table, and every view logs `page_render`. Making a route
   static would need the org in the path — a second URL convention, not worth it here.
6. **Request memoization is shown, not blamed**: the detail page's `generateMetadata` and body
   both call `fetchConversation` → two `upstream_fetch` lines, one API line, same rid.
7. The fetch instrument distinguishes three answers per fetch: `origin` / `memo` (React
   `cache()` per-render registry) / `cache` (`x-served-at` predicate). Mislabelling a memo as a
   data-cache hit is the exact sin the card warns about, so the registry is not optional.

## What ships

### Backend — one header, one assertion

- `apps/backend/src/observability/request-context.middleware.ts`: `res.setHeader('x-served-at',
  new Date().toISOString())` beside the rid echo. Constant `SERVED_AT_HEADER` in
  `request-context.ts`.
- `apps/backend/test/request-id.e2e-spec.ts`: asserts the header parses as a date.
- Nothing else: `PATCH /conversations/:id` (`UpdateConversationDto`, `open|closed`),
  `GET /conversations/:id`, `GET /conversations/:id/messages` already exist. No new backend
  arm, so `docker-compose.yml`, `GET /info`, `arms.e2e-spec.ts` do not change.

### `apps/frontend/lib/api.ts` — arm, tags, instrumented hop, three new calls

Absorbed into the existing file.

```ts
export type CacheArm = 'nostore' | 'cached' | 'tagged' | 'blanket';
export const cacheArm = (v: string): CacheArm => (... ? v : 'tagged');
export const tags = {
  org:           (o) => `org:${o}`,                 // the blanket handle, on every fetch of the org
  conversations: (o) => `org:${o}:conversations`,   // every list variant (sort/filter/page/cursor)
  agents:        (o) => `org:${o}:agents`,
  stats:         (o) => `org:${o}:stats`,
  conversation:  (id) => `conversation:${id}`,      // one row + its messages
};
/** What one conversation write invalidates, per arm. Empty = nothing cached to invalidate. */
export function tagsAfterWrite(arm, { orgId, id }): string[]
//   tagged  → [conversation(id), conversations(orgId)]
//   blanket → [org(orgId)]
//   nostore | cached → []
```

`callApi(url, requestId, init?, cache?: { tags: string[]; revalidate?: number } | 'no-store')`:

- `'no-store'` (or absent): today's behaviour, rid header sent.
- `{ tags, revalidate }`: `init.cache = 'force-cache'`, `init.next = { tags, revalidate }`,
  **no `x-request-id` header** (comment names the cache-key reason), `traceparent` kept.
- Returns `{ response, durMs, served }` where
  `served: { from: 'origin' | 'memo' | 'cache'; ageMs: number; rid: string | null }`:
  `rid` = the echoed `x-request-id` (whose request actually ran), `ageMs = now - x-served-at`,
  `memo` when a per-render `cache(() => new Set<string>())` registry already holds `url+org`,
  else `cache` when `servedAt < startedAt` (wall clock), else `origin`.
- The `upstream_fetch` log line gains `served`, `ageMs`, `originRid`.

Every result type gains `served` (the `fetchInfo` shape — never throws). Changes:

- `fetchConversations(params + cache: CacheArm)` → tags `[org, conversations]`.
- `fetchAgents(orgId, cache)` → tags `[org, agents]`. No mutation path changes memberships
  here; said in the guide.
- `fetchOrgStats(orgId, cache)` → tags `[org, stats]`, `revalidate: 60` (the stretch's budget).
- **new** `fetchConversation(orgId, id, cache)` → `GET /conversations/:id`, tags
  `[org, conversation(id)]`.
- **new** `fetchMessages(orgId, id, cache)` → `GET /conversations/:id/messages`, same tags.
- **new** `updateConversationStatus({ orgId, id, status })` → `PATCH`, through `callApi`, the
  `assignConversation` result shape (failure as a value).
- `fetchInfo` untouched.

### `app/conversations/actions.ts` — the write, and what it revalidates

- **new** `setConversationStatus(formData)` — the file is already `'use server'`. Reads `id`,
  `org`, `status`, `cache` from the form (progressive enhancement: the detail page's form is a
  Server Component `<form action>`, works with JS off). Calls `updateConversationStatus`, then:
  `const t = tagsAfterWrite(arm, …); if (t.length) t.forEach(updateTag); else refresh();`
  — `updateTag` not `revalidateTag(…, 'max')` because the user must read their own write;
  `refresh()` only when nothing is tagged, because of the kind-overwrite hazard above.
  Logs `status_action` with `rid`, `outcome`, `arm`, `tags`.
- `claimConversation(input + cache: CacheArm)`: the same tail on both the success and the 409
  path (the losing browser's re-render must miss the cache too, or drill 14's convergence
  breaks).

### `app/conversations/[id]/page.tsx` — new, a Server Component, zero application JS

- `params.id`; `searchParams` `org` (default `1`), `me`, `cache`. Reading `searchParams` makes
  it dynamic, deliberately (decision 5).
- `generateMetadata` → `fetchConversation` → title `<status> · <id>` (the memo demonstration).
- Body: `Promise.all([fetchConversation, fetchMessages])`. Status, assignee, `version`, tags,
  `createdAt`/`updatedAt`/`lastMessageAt`; messages in a plain list (`data-message`).
- Status form: `<form action={setConversationStatus}>` with hidden `id/org/cache` and a
  `status` button `close`/`reopen` (`data-status-form`). `data-status` on the status text.
- `<Link href={linkTo inbox}>` "back to inbox" — `next/link`, so the router cache is in play.
  Same `linkTo` discipline as page.tsx: carries `org`, `me`, `cache`.
- Footer, the evidence, one line per fetch (`data-fetch="conversation|messages"`,
  `data-served="origin|memo|cache"`):
  `conversation: cache · 12.4s old · filled by rid 3f9c…` / `messages: origin · rid <this
  page's>`, plus the page's own rid. `pnpm logs:trace <filled-by rid>` finds the request that
  ran; `pnpm logs:trace <page rid>` finds no API line at all on a hit.
- `page_render` log line with `route: '/conversations/[id]'`, `arm`, per-fetch `served`.

### `app/conversations/page.tsx` + `conversation-list.tsx` + `org-stats.tsx`

- `?cache=` parsed via `cacheArm`, carried by `linkTo` like `stats` (omitted when default),
  passed to the three fetches, the `ConversationList` (as `query.cache` for load-more and as
  the action input), and the arm note gets a fourth line with switch links.
- The row id cell becomes `<Link href={/conversations/<id>?org&me&cache} prefetch={false}>` —
  50 in-viewport prefetches per page is not the layer under study; `data-conversation-link`.
- The footer gains the served line per fetch (`list`, `agents`, `stats`) with the same
  attributes; `OrgStats` prints `as of Ns ago` from `served.ageMs` — the staleness budget,
  visible.
- `app/api/conversations/route.ts` passes `cache` through, so appended pages are tagged too.
- `page_render` gains `arm` and per-fetch `served`.

### `app/api/revalidate/route.ts` — new Route Handler, the webhook shape

`POST { org, id, cache }` → `tagsAfterWrite(cache, …).forEach(t => revalidateTag(t, { expire:
0 }))`, returns `{ revalidated: [...], now }`. One tag-decision function for both entry points.
It exists because the k6 script and the Playwright fixtures write through the API, which cannot
reach Next's cache — the honest gap that every write path outside a Server Action has.
Unauthenticated, like the Server Actions; named in honest gaps.

### Playwright — `e2e/stale-status.spec.ts` (arm from `E2E_CACHE`, default `tagged`)

Fixtures through the API (`assign-conflict.spec.ts` pattern): newest row of org 1, `PATCH` it
to `open`, then `POST /api/revalidate { cache: 'blanket' }` so the run starts clean.

**Test 1 — "a status change is visible everywhere the user looks"** (the DONE WHEN's test):

1. `goto /conversations?org&cache=<arm>` → row status `open`; record `data-served` of `list`.
2. Click the row's Link → detail → `data-status` `open`; record served.
3. Submit the form → detail `data-status` **`closed`** (read-your-own-write).
   `cached` goes red HERE — the re-render came from the data cache; footer says `cache`.
4. Click "back to inbox" (Link) → row `closed`.
5. `page.goBack()` twice (detail, then the original list entry) → row **`closed`**, and
   `page.on('request')` counts how many `_rsc` requests Back caused.
   `nostore` is predicted to go red HERE (prediction 4) with **zero** requests — the router
   cache.
6. `page.reload()` → `closed`. (`cached` would still show `open` — the tell that it is not the
   browser: a reload clears the client cache and nothing else.)

**Test 2 — "the layer nobody's code fixes"** (green on every arm; asserts the layer's behaviour
as evidence): list loaded → **another agent** changes the status via the API (+
`/api/revalidate`) → this browser clicks into the row (Link) and presses Back → the row still
shows the old status and **zero** server requests were made; clicking the "inbox" Link instead
→ fresh. That is the card's "intermittent". No fix in this repo (known issue 18, a
subscription); the guide says so.

- `e2e/stream.spec.ts`: URL gains `&cache=nostore` — a cached widget lands in the first chunk
  and the fallback never exists. `e2e/assign-conflict.spec.ts`: URLs carry
  `cache=${E2E_CACHE}` so `E2E_CACHE=cached pnpm test:ui` also goes red on convergence.

### `k6/conversations-page.ts` — the cost, against the Next tier

The first k6 script that measures Next (`BASE_URL` `http://next_app:3001`). Whale page:
`/conversations?org=1&pageSize=50&stats=stream&cache=<CACHE>`. Closed model, drill 05's shape
(`scenario()`, 10 VUs, 20s warm-up, 60s). A third scenario `mutate` (excluded from every
measured metric by the existing `scenario:measure` tags): every `MUTATE_EVERY` seconds (0 =
never) it `PATCH`es the row from `setup()` on `nest_server:3002` and `POST`s `/api/revalidate`
with the arm. Two `Counter`s parsed off the HTML per response — `served_origin{fetch:list|
agents|stats}` and `served_cache{…}` — so the summary's own columns say **origin fetches per
100 views** and **stats scans per 100 views**; the API's request log count is the cross-check.
Knobs `CACHE` (`tagged`), `MUTATE_EVERY` (`5`), plus the common ones; catalogued as
`pnpm load page` in `scripts/load.ts` (`check:arms` scans `__ENV`).

### `perf/paint.mts` — `--cache`/`CACHE` knob, default `nostore`

So drill 17's numbers stay what they measured, and `--cache tagged` gives the cached waterfall
(the warm-up load fills the cache). URL and report name carry it.

### Wiring

`README.md` row 18 + `pnpm load page`; `.prettierignore` unchanged; `pnpm typecheck` covers the
new `.mts` flag and the k6 script; `check:arms` for the catalog. No new dependency.

## Predictions, recorded before measuring

1. With `x-request-id` left in the cached fetch (build it that way first, on purpose, then drop
   it): **0 hits** across 10 loads; the header is the key. Recorded, then fixed.
2. `cached`: after "close", the detail re-render says `open`, footer `served: cache`, and the
   API log has no line for the page's rid; `.next/cache/fetch-cache/<hash>` on disk holds the
   `open` body with `tags: ["org:1","conversation:<id>"]`. Reload does not fix it.
3. `tagged`: read-your-own-write in the action's own response (one round trip, drill 14's
   shape); list and detail miss exactly once after the write, then hit; the stats hit
   throughout.
4. `nostore` + `refresh()`: Back to the list shows the OLD status with zero `_rsc` requests —
   `DynamicOnly` does not evict the bfcache. `tagged`'s `updateTag` (`StaticAndDynamic`) does.
   Least certain prediction; the test decides.
5. k6, whale, `MUTATE_EVERY=5`: `nostore` ≈ drill 17's cost, ~3-7 views/s, p50 in seconds, one
   scan per view; `tagged` hundreds of views/s, **zero** stats scans; `blanket` ≈ 12 evictions
   → more than 12 scans (concurrent misses are not coalesced — a stampede per eviction) and a
   p99 that reads like `nostore`.
6. `ui:paint --cache tagged`: widget on screen within ~30ms of FCP; JS bytes unchanged.
7. Stretch: after 60s the next whale view re-runs the scan; whether it blocks that view or
   refetches in the background is read off `page_render.statsMs` — recorded, not assumed.
8. `E2E_CACHE=cached` fails test 1 at step 3 and the assign conflict test; `blanket` green.

## Results

_Not yet measured._

## Verification

1. Branch `drill-18`; plan file to `plans/`; `planned` row in `history.md`; commit.
2. `COMPOSE_PROJECT_NAME=drills pnpm docker:up`; `pnpm db:test` green at 140 + 1;
   `pnpm check:arms`, `pnpm arms`, `pnpm check:tenancy`, `pnpm typecheck`.
3. Prediction 1 by hand (`curl` ×10 on the detail page, read the footer / `upstream_fetch`).
4. `pnpm test:ui` green (6). `E2E_CACHE=cached pnpm test:ui` red (2). `E2E_CACHE=nostore` and
   `E2E_CACHE=blanket` recorded. `E2E_STATS=blocking` still red (1).
5. Evidence pass, recorded under Results: `pnpm logs:trace <rid>` on a hit and a miss;
   `ls`/`cat` of the fetch-cache entry inside the container; the `next build` route table (`ƒ`).
6. `COMPOSE_PROJECT_NAME=drills pnpm docker:up:prod`. `pnpm load page --cache nostore|tagged|
   blanket --mutate-every 5`, plus `tagged --mutate-every 0`, two interleaved rounds, one
   sitting. `pnpm ui:paint --cache tagged --name whale-cached`. Back to `pnpm docker:up`.
7. `pnpm format`, `pnpm lint`, `pnpm typecheck`.

## Write-up

`drills/18-next-cache-layers.md`, one guide: which layer and the evidence (the four-layer
matrix, reproduced or excluded, each with its proof); tag granularity (`org:o:conversations`
because a status change moves a row across every filter and re-sorts every list — org-wide is
correct, not lazy; `conversation:id` for the row; the stats on a time budget because no Next
write path changes messages); the Cloudflare KV equivalent in general terms — KV's eventual
consistency and `cacheTtl` map onto `revalidateTag(…, 'max')` and `revalidate: N`.

## Release

Version 0.18.0, tag `drill/18` on the branch before the merge (the drill 14–17 precedent), PR
opened against `main`, GitHub release with a hand-written body.
