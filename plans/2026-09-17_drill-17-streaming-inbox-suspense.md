# Drill 17 — Stream the inbox with Suspense and measure what it bought

**Status:** planned

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
       count(*) FILTER (WHERE m.created_at >= now() - interval '30 days') AS recent,
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
  recent: number;         // last 30 days
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
