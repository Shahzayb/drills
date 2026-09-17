# Drill 17 — Stream the inbox with Suspense and measure what it bought

**Status:** shipped

Card 17. Prereq was 10. Builds a deliberately slow org-level aggregate, one Suspense boundary,
and the first browser-side measurement instrument in this repo.

## Context

`/conversations` is a Server Component that `await`s everything in the page body before it
returns JSX. The browser receives nothing until the slowest fetch resolves. Today the slowest
fetch is the list itself (~180ms on the whale), so the wait is invisible. The card adds a widget
that is not: an org-level aggregate whose cost is genuine rather than a `sleep`.

The query is the one drill 02 planted for this. `messages.org_id` carries a foreign key and
**no index** — the migration comment says "per-org aggregates are the second cost". Org 1 owns
~40% of 10M messages, and drill 11's `tsv` column took the `messages` heap to ~4.5GB. An
aggregate over the whale's messages is a sequential scan of that heap against
`shared_buffers=128MB`. Drill 11 measured the same scan at ~3.3s under `LIKE`.

Three things have to come out with numbers:

1. What the widget does to TTFB, FCP and JS bytes when the page waits for it.
2. What `<Suspense>` gives back, measured the same way.
3. One piece of this UI that cannot be a Server Component, with the specific reason.

Measurements run against the **production build** (`pnpm docker:up:prod`). Dev mode ships
HMR and unminified chunks, so a JS-bytes number taken there describes the dev server.

## What ships

### `GET /messages/stats` — one statement, no cache

`SearchController` gains `@Get('stats')`, `@QueryBudget(1)`, `@OrgId()`. It sits on the
`messages` controller because it aggregates messages through the tsvector — search machinery,
not conversation listing. `SearchService.stats(orgId)` runs one SELECT inside
`TenantDb.withOrg`, with the explicit `m.org_id = $1` every other messages query carries:

```sql
SELECT count(*)                                                        AS messages,
       count(*) FILTER (WHERE m.tsv @@ to_tsquery('english', $2))      AS negative,
       count(*) FILTER (WHERE m.tsv @@ to_tsquery('english', $3))      AS positive,
       count(*) FILTER (WHERE m.created_at >= now() - interval '90 days') AS recent,
       avg(length(m.message))::float8                                  AS avg_length,
       max(m.created_at)                                               AS last_message_at
  FROM messages m
 WHERE m.org_id = $1
```

The two lexicons are module constants built from the seed corpus's own vocabulary. Negative:
`fail | error | charge | duplicate | block | stop | drop | chase | wrong`. Positive:
`thank | fix | resolve | refund | credit | deploy | confirm | appreciate`. The stemmer folds
`failing`/`failed`/`fails` onto `fail`, which is why the lexicon is stems. A lexicon is not
sentiment analysis and the response says so: `method: 'lexicon'`.

Response shape, camelCase like every other:

```ts
interface MessageStats {
  messages: number;       // count(*) — bigint, Number()'d, same 2^53 cap as known issues 14/27
  negative: number;
  positive: number;
  recent: number;         // last 90 days — the seed ends 2026-08-11, so 30 would read 0
  avgLength: number;
  lastMessageAt: string | null;
  method: 'lexicon';
}
```

`test/search.e2e-spec.ts` grows a `describe('GET /messages/stats')` on the existing fixtures:
the fixture org's exact `messages` count, the other org's rows not counted, lexicon hits on
known bodies (`refunded` is positive; one new `failing` body is negative), and
`x-query-count === 1`.

### The widget, three arms, one wrapper

`apps/frontend/lib/api.ts` — `fetchOrgStats(orgId)` through `callApi`, so the org header,
`x-request-id` and `traceparent` travel. Returns a result object and never throws, the
`fetchAgents` shape.

`apps/frontend/app/conversations/org-stats.tsx` — two Server Components, no directive.
`OrgStats({ stats })` awaits a promise prop and renders the numbers under `data-stats`.
`OrgStatsFallback` is a skeleton of the same height under `data-stats-fallback`, so the swap
does not shift the table (CLS).

`apps/frontend/app/conversations/page.tsx`:

- `?stats=stream | blocking | off`, default `stream`. A URL parameter and not an environment
  variable, the `?mode=offset` precedent: the arms run in one process and interleave in one
  sitting, which drill 07 requires of any A/B. `linkTo()` carries it like `mode`.
- **The fetch is hoisted.** `const statsPromise = fetchOrgStats(orgId)` runs at the top of the
  body, before `await Promise.all([list, agents])`, and is passed down as a prop. Started
  inside the child it would begin only after the list resolved — serialised behind the shell.
- The render differs by one wrapper:

  ```tsx
  {arm === 'stream'   && <Suspense fallback={<OrgStatsFallback />}><OrgStats stats={statsPromise} /></Suspense>}
  {arm === 'blocking' && <OrgStats stats={statsPromise} />}
  ```

- A one-line arm note with switch links, the paging-note pattern.
- `page_render` gains `stats` and `statsMs`, read inside `after()` from the settled promise.

`apps/frontend/app/health/route.ts` reports `mode: process.env.NODE_ENV`, so the instrument
can refuse a dev server.

### The stretch — a filter that must not round-trip

`conversation-list.tsx` gets a text input that filters the loaded rows by id, status, assignee
and tag, case-insensitive substring, `useState`. Caption: "N of M loaded match". What is now
duplicated: the status filter exists as SQL equality over 1M rows and as a JS substring over
≤50 loaded rows. Same word, two semantics — a query against the org, a view over the page. The
`Conversation` type is shared and erased at build; the rules are not shared.

### The forced client component — documented

`conversation-list.tsx` is already `'use client'`. Its comment and the guide state the reason
that survives scrutiny, and reject the general one. Not "it has a button": the date form and
every status link are Server Components, and a `<form action>` bound to a Server Action is
too. The actual reasons, all three held by this one subtree:

- `useOptimistic` paints a state the server has not confirmed, on the click frame, before any
  response exists. A Server Component's output is computed from data the server already has;
  it cannot render a state the server has not seen.
- `appended` pages are state that must survive `refresh()`'s re-render of page 1.
- The filter needle never reaches the server.

The seam is at the table because the table is the smallest subtree holding all three. The
widget sits outside it, despite being the slowest thing on the page.

### Playwright — `e2e/stream.spec.ts`

`goto(url, { waitUntil: 'commit' })` on org 1 with `?stats=${E2E_STATS ?? 'stream'}`. Asserts
in order: the first `[data-conversation]` row is visible; `[data-stats-fallback]` is visible
and `[data-stats]` has count 0; the document is marked; `[data-stats]` becomes visible; the
fallback is gone; the mark is unchanged, so the widget arrived by stream and not by
navigation. **Red run:** `E2E_STATS=blocking pnpm test:ui` fails exactly this test, because
the fallback markup never exists in a blocking document.

### `pnpm ui:paint` — the instrument, `apps/frontend/perf/paint.mts`

Host-run Playwright driving Chromium over CDP, the `pnpm test:ui` split. It lives under
`apps/frontend` because `@playwright/test` resolves there and nowhere else; `.mts` because
that package has no `type` field. `apps/frontend/package.json` gets `measure:paint`, the root
gets `ui:paint`.

Knobs read through `parseArgs` with an environment fallback and printed with `(env)` /
`(default)` provenance, the `db/lib/run.mts` convention reimplemented in a few lines because
that module runs in the container and records under `apps/backend/db/reports`:
`--org`/`ORG_ID` 1, `--rounds`/`ROUNDS` 5, `--arms`/`ARMS` `off,blocking,stream`,
`--page-size`/`PAGE_SIZE` 50, `--url`/`FRONTEND_URL`, `--name`/`NAME`.

Per round the arms are interleaved (drill 05). Each load is a fresh browser context — a cold
cache is what "shipped" means. A CDP session with `Network.enable` and
`Page.setLifecycleEventsEnabled` records:

- the document request: `requestWillBeSent` (t0, and `wallTime` to align the page's clock),
  `responseReceived` (TTFB), every `dataReceived` (chunk time and bytes), `loadingFinished`;
- lifecycle `firstContentfulPaint`, `DOMContentLoaded`, `load` on the same monotonic clock;
- a `MutationObserver` from `addInitScript` stamping `performance.now()` when the first
  `[data-conversation]` and the first `[data-stats]` attach — list visible, widget visible;
- from the page: external script transfer bytes (resource timing), inline `<script>` bytes
  split into `self.__next_f.push` payload and the rest (the `$RC` boundary swaps), document
  bytes;
- `page.screenshot()` on the FCP lifecycle event and after `load`, last round only.

Output under `apps/frontend/perf/reports/<stamp>[-<name>]-paint-org<org>-size<n>/`:
`summary.txt` with per-arm medians (TTFB, FCP, list, widget, DCL, load, document KB, JS KB,
inline KB, chunks), `run.json`, `waterfall.svg` (one panel per arm: the document bar with
chunk ticks, script/stylesheet/font rows, vertical FCP / widget / load markers), and
`fcp.png` / `loaded.png` per arm. PNGs are gitignored; the SVG and text are committed. The
header prints `/health`'s `mode` and exits 1 on `development`.

### `pnpm db:search aggregate` — the widget's plan

A subcommand in `apps/backend/db/search.mts` reusing `openScope`, `explainJson`, `timed` and
`record`: `EXPLAIN (ANALYZE, BUFFERS)` of the shipped statement as `app_user` under the
policy, `ROUNDS` median, once with the default parallel setting and once with
`max_parallel_workers_per_gather = 0`. Run for `--org 1` and `--org 150`. Reports shared hit
and read blocks, so "why is it slow" is blocks × 8KB against the heap size. Catalogued in
`scripts/measure.ts`.

### Wiring

- `apps/frontend/package.json`: `measure:paint`, `typecheck` (`tsc --noEmit`); root
  `typecheck` chains it, because the perf script needs `lib: dom` and the root config has
  `types: ["node"]` only.
- `.gitignore`: `apps/frontend/perf/reports/**/*.png`.
- `README.md`: row 17, `pnpm ui:paint` under Commands.
- No backend environment arm, so `docker-compose.yml`, `GET /info` and `arms.e2e-spec.ts` do
  not change.

## Predictions, recorded before measuring

1. Org 1 is a Parallel Seq Scan over the whole `messages` heap, 2–5s, with `Shared Read
   Blocks` in the hundreds of thousands. Org 150 flips to a Bitmap Heap Scan through
   `messages_org_tsv_idx` — btree_gin serves `org_id = $1` on its own — and lands under 100ms.
2. `blocking`: TTFB ≈ the aggregate, FCP within ~50ms of it. `stream`: TTFB within noise of
   `off` (~200ms, the list fetch), and widget-visible ≈ blocking's TTFB. TTFB moves most.
3. External JS bytes are identical across arms to the byte. The widget is a Server Component
   and ships no component code. The `stream` document is larger by under 2KB of inline `$RC`
   script plus the widget's RSC payload.
4. The inline `__next_f` payload is roughly the table's HTML size: the seam's cost is the 50
   rows shipped twice, once as markup and once as data for hydration.
5. `E2E_STATS=blocking pnpm test:ui` fails exactly one test.
6. `page_render.totalMs` is the same ~3s on `blocking` and `stream`. The user gains
   time-to-content; the server gains nothing. Caching is card 19's job.

## Results

Production build (`pnpm docker:up:prod`), Chromium via Playwright on the host, 2.5M
conversations, 10M messages, `messages` heap 5,211MB against `shared_buffers=128MB`. Every
number is a median of 5 rounds with the arms interleaved per round and a discarded warm-up
load per arm.

### The DONE WHEN — before/after, whale

`pnpm ui:paint --name whale` → `apps/frontend/perf/reports/2026-09-17-124208-whale-paint-org1-size50/`

| arm | TTFB | FCP | list on screen | widget on screen | last byte | load | doc KB | **JS KB** | CSS KB | RSC payload KB | other inline KB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `off` | 11 | 35 | 18 | — | 14 | 53 | 10.4 | **134.2** | 63.4 | 30.4 | 0.0 |
| `blocking` | **1,335** | **1,388** | 1,346 | 1,346 | 1,342 | 1,390 | 10.9 | **134.2** | 63.4 | 31.6 | 0.0 |
| `stream` | **13** | **35** | 18 | 1,333 | 1,333 | 1,336 | 12.1 | **134.2** | 63.4 | 31.8 | 0.9 |

Milliseconds from the document request being sent; KB on the wire (transfer size, gzip).

- **TTFB moved most: 1,335ms → 13ms, 103x.** FCP 1,388 → 35ms, 40x. Both land within
  noise of the `off` arm — the widget is off the critical path entirely.
- **JS bytes did not move at all: 134.2KB on every arm, to the byte.** The widget is a
  Server Component and ships no code. The stream arm's whole cost is 0.9KB of inline script
  (the `$RC` boundary swap, 845 bytes) and 1.2KB more of gzipped document.
- The widget itself arrives at the same time either way: 1,346ms blocking, 1,333ms streamed.
  Nothing got faster. The page stopped waiting.
- The aggregate ranged 1.3–3.5s across the session depending on the OS page cache; the
  ratios held at every point.

### The waterfall

`waterfall.svg` in the same directory, drawn from the last round; the FCP and loaded
screenshots beside it are the same load. The document row on the `blocking` arm is one
1,364ms "waiting" bar with FCP, widget and load stacked at its right end. On `stream` it is a
12ms wait, then a 1,296ms "receiving" bar with FCP at 34ms and the widget at 1,297ms — the
slow widget arrives 1,263ms after first paint. The raw chunks, `Accept-Encoding: identity`:

```
chunk 0 +    0ms    5786 bytes
chunk 1 +    1ms   65528 bytes  data-conversation= · data-stats-fallback · <template id="B:0"> · __next_f.push
chunk 2 +    1ms   21682 bytes  data-stats-fallback
chunk 3 + 1277ms     959 bytes  __next_f.push
chunk 4 + 1278ms    1676 bytes  <div hidden id="S:0"> · data-stats="ready" · $RC=
```

93KB in the first millisecond, including every row of the table and the placeholder; 2.6KB
1.3 seconds later, holding the widget's HTML, the script that swaps it in, and its RSC payload.

### The same page on the tail org

`pnpm ui:paint --org 150 --rounds 3 --name tail` →
`…/2026-09-17-124229-tail-paint-org150-size50/`

| arm | TTFB | FCP | widget on screen | load |
|---|---|---|---|---|
| `off` | 13 | 37 | — | 54 |
| `blocking` | 26 | 60 | 31 | 66 |
| `stream` | 16 | 40 | 33 | 58 |

Where the aggregate takes 9ms, streaming buys 10ms of TTFB and costs 2ms of widget time. It
is not free and it is not a default: a boundary around something fast is a chunk boundary
nobody needed.

### What the server did — `page_render`, org 1

| arm | `totalMs` | `upstreamMs` (list) | `statsMs` |
|---|---|---|---|
| `blocking` | 1,333.85 | 8.02 | 1,331.24 |
| `stream` | 1,321.86 | 4.87 | 1,320.90 |
| `off` | 7.69 | 4.66 | — |

The server was busy for the same 1.3 seconds on both arms. The user gained time-to-content;
the server gained nothing. A cache is card 19.

### The query — `pnpm db:search aggregate`

`apps/backend/db/reports/2026-09-17-073738-whale-search-aggregate-org1/` and
`…-073641-tail-search-aggregate-org150/`, as `app_user` under the policy, median of 3 with the
first discarded:

| org | cell | scan node | workers | hit / read blocks | read MB | median ms |
|---|---|---|---|---|---|---|
| 1 (40.0%) | shipped | Parallel Seq Scan | 2 | 4,038 / 662,990 | 5,180 | 2,319.04 |
| 1 | `max_parallel_workers_per_gather = 0` | Seq Scan | 0 | 5,258 / 661,770 | 5,170 | 3,198.60 |
| 1 | `enable_seqscan = off` | Bitmap Heap Scan (gin) | 2 | 760 / 568,667 | 4,443 | 2,827.43 |
| 150 (0.1%) | shipped | Bitmap Heap Scan (gin) | 0 | 35 / 3,161 | 25 | 9.24 |

**The whale reads 663k of the heap's 667k blocks — 5.1GB — per request**, and nearly all of
it is `read` rather than `hit`: `shared_buffers` is 128MB and the heap is 40x that. Two
parallel workers were worth 0–28% across runs, inside I/O noise, because the scan is bound
by disk and not CPU. The forced GIN path reads 15% fewer blocks and the planner still
declines it at 40% selectivity. JIT compiled 23 functions for **235ms of every request**.

**Org 150 is 250x faster on the identical SQL**: 3,161 blocks through `messages_org_tsv_idx`,
because btree_gin serves `org_id = $1` alone. Same endpoint, same statement, one tenant
pays a 5GB scan and the other an index lookup — drill 09's finding on a new table.

### The forced client component, and the seam

`conversation-list.tsx` holds three things that exist only in the browser: the optimistic
row that paints before any response exists, the appended pages that survive `refresh()`, and
the filter needle that never reaches the server. Each alone forces `'use client'`. The seam
is at the table because that is the smallest subtree holding all three; the widget above it
is the slowest thing on the page and is a Server Component. "It has a button" is not a
reason — the date form and every filter link are Server Components.

### The stretch

The client-side filter narrows the ≤50 loaded rows by substring. Duplicated: the *shape* of
a status filter — SQL equality in `filtersFor` over 1M rows, a JS `includes` over the page.
The `Conversation` type is shared and erased. Does it matter? Only if someone reads one as
the other: `?status=open` and typing "open" return different sets, and the caption says "of
N loaded" so nobody does.

### Predictions, and what happened

| # | prediction | outcome |
|---|---|---|
| 1 | org 1 Parallel Seq Scan, 2–5s, hundreds of thousands of blocks read; org 150 a Bitmap Heap Scan through the GIN under 100ms | **right** — 663k blocks, 2.3–3.2s; 9.24ms through the GIN |
| 2 | blocking TTFB ≈ the aggregate, stream TTFB within noise of `off`, TTFB moves most | **right** — 1,335 vs 13 vs 11ms; 103x |
| 3 | external JS identical to the byte; stream adds <2KB inline | **right** — 134.2KB on all three; +0.9KB inline, +1.2KB document |
| 4 | the RSC payload ≈ the table's HTML | **half right** — 32.6KB of payload against 51.9KB of `<tbody>`: the rows do ship twice, but as JSON props, not as a second copy of the markup |
| 5 | `E2E_STATS=blocking` fails exactly one test | **right** — `[data-stats-fallback]` never exists |
| 6 | `totalMs` the same on both arms | **right** — 1,334 vs 1,322ms |

### Bugs the measurements found

- **The fallback moved the table.** Two lines against the widget's three shifted everything
  below it 18px when the boundary resolved — visible only by putting `stream-fcp.png` and
  `stream-loaded.png` side by side. Fixed by giving the fallback a third line.
- **The `off` arm loads faster than the `firstContentfulPaint` lifecycle event arrives.**
  `page.goto` resolved on `load`, the context closed, and the FCP screenshot fired into a
  closed page. The instrument now waits up to 500ms for the event.
- **`SELECT count(*) FROM messages` inside the RLS scope counts one org.** The aggregate
  instrument's first run printed "3,995,594 of 3,995,594 (100.0%)" for the whale, because the
  total was read as `app_user`. Read as the owner now.
- **Parallel query's value is not a number here.** 3,125 vs 3,152ms on one run, 2,319 vs
  3,199ms on the next, same statement, same table. I/O noise on a laptop's Docker VM is
  larger than the effect. Recorded as a range rather than a verdict.

## Verification

1. Branch, plan file, `history.md` planned row, commit.
2. `COMPOSE_PROJECT_NAME=drills pnpm docker:up` for the backend work. `pnpm db:test` green at
   136 plus the new cases. `pnpm check:arms`, `pnpm arms`, `pnpm check:tenancy`,
   `pnpm typecheck`.
3. `pnpm db:search aggregate --org 1` and `--org 150`, recorded under `db/reports/`.
4. `COMPOSE_PROJECT_NAME=drills pnpm docker:up:prod`. `pnpm test:ui` green at 4.
   `E2E_STATS=blocking pnpm test:ui` red by one. `pnpm ui:paint --name whale` (5 rounds × 3
   arms, one sitting), `pnpm ui:paint --org 150 --name tail`. `curl -N -H 'Accept-Encoding:
   identity'` as the eyeball check that chunks arrive apart.
5. `COMPOSE_PROJECT_NAME=drills pnpm docker:up` to return to dev.
6. `pnpm format`, `pnpm lint`, `pnpm typecheck`.

## Write-up

`drills/17-streaming-the-inbox-with-suspense.md`, one guide, answering the card's three
questions with numbers: which number moved most and what the user gained, the rule for when
`'use client'` is forced, and where the server/client seam is in this inbox and why there.

## Release

Version 0.17.0, tag `drill/17` on the branch before the merge (the drill 14–16 precedent), PR
opened against `main` and left unmerged, GitHub release with a hand-written body.
