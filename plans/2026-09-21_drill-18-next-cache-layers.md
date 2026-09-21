# Drill 18 — Make Next serve stale data on purpose

**Status:** shipped

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

Dev server unless stated (`pnpm docker:up`), org 150 for the by-hand evidence, org 1 for cost.

### Prediction 1 — the request id is in the cache key

Built with `x-request-id` on the cached fetch first, on purpose, then dropped it. Ten loads of
`/conversations/<id>?org=150` each way, reading `data-served` off the page's own footer:

| cached fetch sends `x-request-id` | `conversation:` answers |
|---|---|
| yes | **10 × `origin`** — every load ran the API |
| no | **1 × `origin`, 9 × `cache`** — the first load filled it, nine hit |

```bash
for i in $(seq 1 10); do curl -s "localhost:3001/conversations/$ID?org=150" | grep -o 'data-fetch="conversation" data-served="[a-z]*"'; done | sort | uniq -c
```

The cache directory says the same thing another way. After the arm-A loads,
`apps/frontend/.next/dev/cache/fetch-cache/` held **43 entries for each of the three upstream
URLs** — one per load, because each load's id made a new key — and the page still said `origin`
every time. Next strips `traceparent` and `tracestate` from the key by name
(`server/lib/incremental-cache/index.js:285-287`) and knows nothing about ours. Confirmed, and the
line `if (policy === 'no-store') headers.set(REQUEST_ID_HEADER, requestId)` in `callApi` is why.

### Request memoization — measured, and one surprise

The detail page calls `fetchConversation` three times per view: `generateMetadata`, the page
body and `StatusForm`. On the `nostore` arm the API logs **one** `http_request` for the row per
view (three for the page: row, messages, agents) — memoization spans all three, including
`generateMetadata`. The evidence line beside the button says `form: cache · filled by this
render`: the response predates its asker and the rid is this page's own.

```bash
docker compose logs nest_server --no-log-prefix --since 10s | grep <page rid> | grep -c '"msg":"http_request"'   # → 3
```

The surprise: the **first** render of the route after it was compiled (dev) logged **5** — no
dedupe at all — and a throwaway page with two identical `no-store` fetches logged 2 on its
first request and 1 on every request after. Dev's first render of a fresh route is not a
steady-state measurement; every number here is from the second load onwards.

A first-cut `memo` label (a per-render registry via React `cache()`) was built and removed: it
claimed dedupe that the API log contradicted on that first render. The label is what the
predicate observes — `cache` — and the rid says who filled it.

### The reproduction — `E2E_CACHE=cached pnpm test:ui`

Three tests go red, all three at the render after a write:

| test | what it saw |
|---|---|
| stale-status › after the write | the action's own re-render says `open`; evidence `cache (filled by 461f5b29…, page e55cac22…)` — the rid of the page load BEFORE the write |
| assign-conflict › the loser converges | Bob's re-render is the cached list; Alice's name never arrives |
| assign-conflict › a claim that wins | Alice's own re-render is the cached list; her name never arrives |

By hand, the same thing with an out-of-band write (dev, org 150): the API says `closed`, three
consecutive loads of the detail page say `open` with `conversation: cache`, and one
`POST /api/revalidate {cache: "tagged"}` turns the next load into `origin` and `closed`.

```bash
curl -s -X PATCH -H 'x-org-id: 150' -H 'content-type: application/json' -d '{"status":"closed"}' localhost:3002/conversations/$ID
curl -s "localhost:3001/conversations/$ID?org=150&cache=cached" | grep -o 'data-conversation-status="[a-z]*"'   # open, open, open
curl -s -X POST -H 'content-type: application/json' -d "{\"org\":\"150\",\"id\":\"$ID\",\"cache\":\"tagged\"}" localhost:3001/api/revalidate
curl -s "localhost:3001/conversations/$ID?org=150&cache=cached" | grep -o 'data-conversation-status="[a-z]*"'   # closed
```

`tagged`, `nostore` and `blanket` pass all six; `E2E_STATS=blocking` still fails exactly one.

### The router cache — prediction 4 was wrong, and the test says how

Test 1's two Backs, on every arm including `nostore`: **to the detail page: no request; to the
original list entry: one `/conversations?_rsc=` request.** A Server Action's revalidation —
`refresh()` included — leaves the router unwilling to reuse an entry rendered before the
action; the entry rendered after it (the detail page) is reused. `updateTag` and `refresh()`
differ on the DATA cache, not on this.

Test 2, no action in this browser: another agent's write through the API (+ `/api/revalidate`,
so the data cache is fresh), then Back → the row still says `open` and **zero** RSC requests
were made. Then a Link into the row → `closed`. Same page, two ways back, two answers — the
card's "intermittent" — and nothing in this repo fixes the Back case, because nothing told this
browser anything (known issue 18).

### The evidence, one hit, dev

One load of the detail page after the entry was filled. Page rid `834b74dc…`:

```
page_render  route=/conversations/[id] arm=tagged totalMs=34.59 upstreamMs=2.28
             served={conversation:cache, messages:cache, agents:cache}
```

```bash
docker compose logs nest_server --no-log-prefix --since 15s | grep -c 834b74dc   # → 0
```

The API has no line for this page's request: nothing ran. The entry that answered is a file:

```
.next/dev/cache/fetch-cache/497ccaed3f8d…  kind=FETCH  revalidate=31536000
  tags=['org:150', 'conversation:019fee1e-6dbe-7384-90c7-32511708296e']
  url=http://nest_server:3002/conversations/019fee1e-…   x-request-id=08d27eed-…   x-served-at=13:16:12.770Z
  body={"id":"019fee1e-…","status":"open","assigneeId":"1373","version":1,…}
```

The rid inside it (`08d27eed…`) is the request that filled it, and the footer's `filled by rid`
prints the same value — `pnpm logs:trace 08d27eed` finds that request in both services;
`pnpm logs:trace 834b74dc` finds it in the web tier only. In dev the directory is
`.next/dev/cache/fetch-cache/`; `revalidate=31536000` is Next's "one year" for an entry with no
`revalidate` of its own.

### Production: the route table, memoization, the cache directory

`pnpm docker:up:prod`. The build's route table:

```
├ ƒ /conversations
├ ƒ /conversations/[id]
ƒ  (Dynamic)  server-rendered on demand
```

No Full Route Cache for either — both read `searchParams`. The response carries
`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` and no
`x-nextjs-cache`. Memoization in prod, steady state: 3 API requests per detail view on
`nostore` (row once for three calls, messages, agents), three runs of three. The prod cache
directory is `.next/cache/fetch-cache/`.

### The cost — `pnpm load page`, whale, 10 VUs, 20s warm-up, 60s measured, one write / 5s

Production build, org 1, `pageSize=50`, `stats=stream`. The writer flips the newest row's
status through the API and calls `/api/revalidate` with the arm 17 times per 80s run (12–13
inside the measured window). Round 1, one sitting, arms in order:

| arm | views (60s) | views/s | p50 | p95 | p99 | max | origin list / agents / stats per 100 views | stats scans |
|---|---|---|---|---|---|---|---|---|
| `nostore` | 87 | **1.45** | 6,131ms | 13,382 | 13,890 | 13,952 | 100 / 100 / 86 | 75 |
| `tagged` | 13,106 | **218.43** | 32.86ms | 59.06 | 86.17 | 2,082 | 0.5 / 0.0 / 0.0 | **0** |
| `blanket` | 6,011 | **100.18** | 17.66ms | 42.44 | **2,062.80** | 12,118 | 1.0 / 1.0 / 0.9 | **56** |
| `tagged`, no writer | 13,860 | 231.00 | 29.15ms | 72.23 | 101.24 | 166 | 0 / 0 / 0 | 0 |

Round 2, same order, after a Docker restart between the two halves:

| arm | views (60s) | views/s | p50 | p95 | p99 | stats | writes |
|---|---|---|---|---|---|---|---|
| `nostore` | 95 | 1.58 | 5,463ms | 13,787 | 14,108 | 75 scans, **20 views without a widget** | 17 |
| `tagged` | 14,242 | 237.37 | 29.71ms | 54.87 | 79.30 | 0 scans, 14,242 cache answers | 16 |
| `blanket` | 5,804 | 96.73 | 17.48ms | 49.66 | 2,088.77 | **57 scans**, 19 views without a widget | 17 |
| `tagged`, no writer | 15,562 | 259.37 | 26.95ms | 53.81 | 74.68 | 0 scans | 0 |

The ratios held: `tagged` at 150–163x `nostore`'s throughput, `blanket` at 41–42% of
`tagged`'s, 56–57 scans per run. "Views without a widget" is the `OrgStats` error branch,
which prints no evidence line: under ten concurrent scans (`nostore`) or five (`blanket`'s
stampede) the stats fetch fails for a fifth of `nostore`'s readers and 0.3% of `blanket`'s.
Round 1's "86 per 100" was the same thing before the summary counted it.

```bash
pnpm load page --cache nostore --mutate-every 5 --page-size 50 --name nostore-m5-r1
pnpm load page --cache tagged  --mutate-every 5 --page-size 50 --name tagged-m5-r1
pnpm load page --cache blanket --mutate-every 5 --page-size 50 --name blanket-m5-r1
pnpm load page --cache tagged  --mutate-every 0 --page-size 50 --name tagged-m0-r1
```

→ `k6/reports/2026-09-21-184238-nostore-m5-r1-…/summary.txt` and siblings.

What the table says:

- **`nostore` is not "the same page, slower". It is ten concurrent 5GB scans against 128MB of
  `shared_buffers`** — drill 17 measured one scan at 1.3s; ten at once are 6–14s each, 1.5
  views a second, and a fifth of the views lose the widget outright. Disabling caching to fix
  a stale read costs 150x the throughput on the whale.
- **`tagged` pays for the writes it gets and nothing else.** 65 origin list fetches for 17
  writes — about four readers miss at once per eviction, the rest wait on the incremental
  cache's per-key lock — and the stats never run. Against the no-writer run the writer costs
  5% of throughput (231 → 218) and 4ms of p50.
- **`blanket` turns 12 writes into 56 scans.** Every eviction of `org:1` empties the stats
  entry too, and 10 VUs missing together run 4–5 scans each time. p99 2,063ms is the reader
  that waited on a scan; max 12,118ms is one that waited on five. The p50 is *lower* than
  `tagged`'s (17.66 vs 32.86ms) — a closed-model artifact: the VUs parked on a scan stop
  competing, and the others go faster. Throughput and p99 are the honest columns.
- Predictions 5 held in shape and missed in scale: `nostore` at 1.5 views/s rather than 3–7
  (the stampede on the DB, not the query), `blanket` at 56 scans rather than "more than 12".

### `pnpm ui:paint --cache tagged --name whale-cached`

Same instrument as drill 17, same page, the widget answered from the data cache (the discarded
warm-up load fills it). Medians of 5, production build, whale:

| arm | TTFB | FCP | list | widget | load | chunks | docKB | jsKB |
|---|---|---|---|---|---|---|---|---|
| `off` | 10 | 33 | 15 | — | 50 | 1 | 11.7 | 137.8 |
| `blocking` | **12** | 35 | 16 | **16** | 51 | 1 | 12.3 | 137.8 |
| `stream` | 10 | 33 | 15 | **30** | 50 | **1** | 13.2 | 137.8 |

Against drill 17's `nostore` numbers (TTFB 1,335 / widget 1,346 blocking; 13 / 1,333 stream):
the blocking arm's TTFB fell 111x because the aggregate it waited for is now a 1ms read, and
the stream arm sends **one chunk** — the boundary resolves before the shell flushes, so there
is nothing left to stream. A `<Suspense>` around a cache hit is a wrapper around nothing,
which drill 17's tail-org run already said. JS is **137.8KB against 134.2KB**: the 3.6KB is
`next/link` on the fifty row links — the price of putting the router cache in play.

→ `apps/frontend/perf/reports/2026-09-21-190427-whale-cached-paint-org1-size50-tagged/summary.txt`.

### The stretch — what `revalidate: 60` does when it expires

Four loads of the whale's list on `tagged`, read off the footer and `page_render`, with the
API log beside them:

| load | entry age | `stats:` | `statsMs` | API |
|---|---|---|---|---|
| 1 | 45s | `cache · filled by 20a21b57` | 1.04 | — |
| 2 | 46s | `cache · filled by 20a21b57` | 0.32 | — |
| 3, 65s later | 113s | `cache · filled by 20a21b57` | 1.43 | `/messages/stats` **rid 209f5d03**, arrived 14:05:55.2, done 14:05:57.1 |
| 4, 1s after | 114s | `cache · filled by 20a21b57` | 1.05 | `/messages/stats` **rid 68ad6182**, done 14:05:59.1 |

```bash
docker compose logs nest_server --no-log-prefix --since 4m | grep '/messages/stats' | grep '"msg":"http_request"'
```

Time-based expiry is **stale-while-revalidate**: the reader past the budget gets the old
entry in 1ms and Next refetches behind it — no view paid the scan. And the two refetches are
**not coalesced**: load 4 arrived while load 3's revalidation was still scanning and started
its own. The on-disk entry afterwards carries rid `68ad6182`, the second one. Prediction 7
answered: background, and one refetch per reader in the window.
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
