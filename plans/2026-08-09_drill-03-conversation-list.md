# Drill 03 — Paginated conversation list, API and RSC page

**Status:** shipped

Card 03. Ship the list endpoint and the page that renders it, the obvious way:
`LIMIT`/`OFFSET`, no joins, no cursor, no cleverness. Cards 08, 09 and 10 each need a
specific naive thing to break, and building the sophisticated version now removes the
moment where it fails with real data behind it.

The naivety is scoped, not total. Correctness (tenant scoping, validation, a total
ordering) is not the thing being deferred — *scalability* is. A wrong endpoint teaches
nothing when it gets slow.

---

## What gets built

**Backend** — `apps/backend/src/`

| File | Role |
|---|---|
| `tenancy/org-id.decorator.ts` | `@OrgId()` — reads and validates the `X-Org-Id` header |
| `conversations/dto/list-conversations.query.ts` | query DTO: `page`, `pageSize`, `sort` |
| `conversations/conversations.service.ts` | the two SQL statements |
| `conversations/conversations.controller.ts` | `GET /conversations` |
| `conversations/conversations.module.ts` | wiring |
| `app.module.ts` | + `ConversationsModule`, + global `APP_PIPE` |

**Frontend** — `apps/frontend/`

| File | Role |
|---|---|
| `lib/api.ts` | + `fetchConversations()` |
| `app/conversations/page.tsx` | Server Component list page |
| `app/page.tsx` | + a link to it |

**Fixtures and tests**

| File | Role |
|---|---|
| `apps/backend/db/seed.sql` | pad `conversations` to 24 rows so pagination has something to page |
| `apps/backend/test/conversations.e2e-spec.ts` | integration test, real HTTP, real Postgres |

---

## Decisions

### Tenant identity is a header, not a query param

`GET /conversations` is scoped by `X-Org-Id`, read through a custom `@OrgId()` param
decorator. Not `?orgId=`.

There is no auth in this repo on purpose, so tenant identity has to come from *somewhere*
explicit. The header is the stub that a session or a JWT claim replaces later, and keeping
it out of the query DTO keeps the two kinds of input separate: **`page` and `pageSize` are
things the caller may choose; the org is not.** A query param puts them in the same bag,
and card 07 (tenant isolation) is precisely about what happens when identity is treated as
ordinary user input.

The decorator rejects a missing or non-positive-integer header with 400 before the handler
runs. It does not check that the org *exists* — that would be a query per request to
protect against a caller who is already trusted to name their own tenant. Card 07 revisits
the whole seam.

### Validation lives in a DTO at the HTTP edge, registered via `APP_PIPE`

`ValidationPipe` is registered as an `APP_PIPE` provider in `AppModule`, not with
`app.useGlobalPipes()` in `main.ts`.

`main.ts` never runs in tests — `Test.createTestingModule()` builds the app from the module
graph. A pipe installed in `main.ts` is therefore absent from every e2e test, so the tests
validate a *different application* than the one that gets deployed. As a provider it is
part of the graph and applies in both.

Options: `transform: true`, `whitelist: true`, `forbidNonWhitelisted: true`. Explicit
`@Type(() => Number)` on each numeric field rather than `enableImplicitConversion` —
implicit conversion coerces silently and in surprising places.

### `pageSize` has a ceiling of 100, default 50

Without a ceiling, `?pageSize=1000000` is a free denial-of-service: one request, one full
table scan, one enormous JSON body. The ceiling is a `@Max()` on the DTO, which means the
answer to "what happens on `pageSize=101`?" is a 400 from the edge, not a slow 200.

Default 50 because that is what the card's DONE WHEN renders.

### `ORDER BY <sort> DESC, id DESC` — the tiebreaker is not optional

`updated_at` is not unique. Under `LIMIT`/`OFFSET`, an ordering with ties is *undefined*
between equal rows, so the same row can appear on page 1 and page 2, or on neither. The
seed now writes deliberate `updated_at` ties into the padded conversations, so this is
reproducible here, not theoretical.

`id DESC` makes the ordering total. This is a correctness fix, not an optimisation, which
is why it is in the naive version.

It does raise the bar for card 09: the index that fully serves this query is
`(org_id, <sort>, id DESC)`, not `(org_id, <sort>)`.

### `sort` is an allowlist, because `ORDER BY` cannot be parameterised (STRETCH)

`?sort=updated_at|created_at`. A placeholder can only ever be a *value*; `ORDER BY $1`
sorts by the constant string, silently, with no error. So the column name has to be
interpolated — which means the only thing standing between the caller and SQL injection is
that the string was mapped through an object of known-good column names first.

Consequence for card 09, written down now: two sort columns means two composite indexes,
`(org_id, updated_at DESC, id DESC)` and `(org_id, created_at DESC, id DESC)`. Every
sortable column is another index on a 2.5M-row table, taxing every write. That is the
argument against letting the UI sort by anything it likes.

### `total` is a second `COUNT(*)`, deliberately

The endpoint returns `total` and `totalPages`, computed by a separate
`SELECT count(*) FROM conversations WHERE org_id = $1`.

This is the first thing expected to die. `count(*)` in Postgres has no shortcut — MVCC
means visibility is per-row, so it reads every matching row, every request. At 20 rows it
is free. At 2.5M it is the slowest part of a page that has nothing to do with counting.

It stays because a page number UI requires it, and because card 08 is more instructive when
the thing being removed was actually load-bearing.

### No joins

The rows carry `assignee_id`, not an assignee *name*; no message counts. The card says no
joins and the schema has none to hide behind — `conversations` has everything the list
needs. The N+1 and join-cost drills need this to still be true when they arrive.

### Ids stay strings in the JSON, `total` becomes a number

`node-pg` returns `bigint` (int8) as a **string**, because a bigint can exceed
`Number.MAX_SAFE_INTEGER` and silently lose precision as a JS number. `assignee_id` and
`org_id` are bigints, so they stay strings all the way out.

`count(*)` is also bigint and also arrives as a string, but a row count that overflows 2^53
is not a database this repo will ever have, so it is cast to a number where a number is the
honest type.

### The page uses plain `<a>`, not `next/link`

DONE WHEN requires proving the page works with JavaScript disabled. `next/link` would still
work — it renders an anchor — but it ships a client component and prefetches the RSC
payload, which muddies the claim being tested. A plain anchor makes the page provably a
document.

`next/link` is the normal choice for a real app, and the guide explains what it buys.

---

## Deliberately not done

- No cursor / keyset pagination. Card 08.
- No composite index. Card 09.
- No caching of the count or the page. Card 10.
- No `loading.tsx` / `<Suspense>`. The card wants a blocking server render with no spinner,
  so the absence is the point.
- No org-existence check, no 404 for an unknown org. An unknown org is an empty list.
- No styling effort.

---

## Verification

1. `pnpm docker:up && pnpm db:migrate && pnpm db:seed` — 24 conversations.
2. `curl -s -H 'X-Org-Id: 1' 'localhost:3002/conversations?page=1&pageSize=50'`
3. `page=-1`, `pageSize=101`, `sort=drop_table`, missing header → 400 each.
4. `pnpm db:test` — the integration test, real HTTP, real Postgres, in the container.
5. Browser at `localhost:3001/conversations`, JS disabled, rows still there.
6. `curl -w` TTFB against both the endpoint and the page, recorded below.

---

## Divergence from the plan

The seed was padded to **60** extra conversations, not 20. The card's DONE WHEN wants a
full 50-row page rendered, which 24 rows in the table cannot produce. Final fixtures: 64
conversations, 63 of them in org 1.

Nothing else changed.

---

## Writeup

### What is rendered on the server, and what shipped to the client?

All of it is rendered on the server. `app/conversations/page.tsx` is a Server Component: the
`fetch`, the JSON parse, the `.map()` over rows and the `<table>` all run in the Next
process. `curl` — which executes no JavaScript at all, and is therefore a stricter test than
toggling the browser setting — returns 50 `<tr>` elements and 50 distinct conversation uuids
in the HTML body.

What ships to the browser:

- **HTML** with every row already in it.
- **The RSC payload**, inlined in the document as `self.__next_f.push(...)` script tags. It
  is visible in the response and it does contain the row text a second time, which looks
  like duplication and is worth being precise about: it is not a data fetch and it is not
  the component's source. It is React's serialised description of the rendered tree, used
  to reconcile on navigation. There is no request back to the API from the browser.
- **Framework JavaScript** — React plus the App Router runtime, and in `next dev` a large
  amount of HMR machinery that `next start` does not ship.

What does **not** ship: zero application components. There is no `"use client"` anywhere in
this route, so none of the page's own code exists in the client bundle. Sorting and paging
are anchors, so they need no JavaScript to work.

### Where is the page size validated, and what happens on `page=-1`?

At the HTTP edge, in `ListConversationsQuery`, by a `ValidationPipe` registered as an
`APP_PIPE` provider. `@Max(100)` on `pageSize`, `@Min(1)` on `page`. Neither the controller
nor the service contains a validation branch, and neither ever sees an out-of-range value.

`?page=-1` → **400**, before the handler runs and before Postgres is touched:

```json
{ "message": ["page must not be less than 1"], "error": "Bad Request", "statusCode": 400 }
```

The page passes `page` through unvalidated on purpose, so `/conversations?page=-1` renders
the API's 400 body in an error panel rather than silently correcting to page 1. One owner
for the rule.

Also verified: `page=0` → 400, `page=abc` → 400, `pageSize=101` → 400, `pageSize=100` → 200
(the bound is inclusive), `sort=id` → 400, `?pageSze=10` → 400 (`forbidNonWhitelisted`),
missing `X-Org-Id` → 400, `X-Org-Id: abc` → 400, `X-Org-Id: 999` → 200 with an empty page.

### Baseline measurements

64 conversations in the table, 63 in org 1. `docker compose` on one laptop, `next dev`, 12
requests each, warmed.

| | min | p50 | p95 |
|---|---|---|---|
| `GET /conversations?pageSize=50` | 1.7 ms | **2.0 ms** | 2.2 ms |
| `GET /conversations?pageSize=1` | 1.2 ms | 1.5 ms | 2.0 ms |
| `GET /conversations?page=2&pageSize=50` | 1.4 ms | 1.6 ms | 2.1 ms |
| `GET /health` (control) | 0.9 ms | 1.3 ms | 2.7 ms |
| `GET /conversations` page, 50 rows | 61.1 ms | **65.7 ms** | 74.5 ms |

The endpoint is ~0.7 ms above an empty health check, and page size does not measurably
change it. The page's 66 ms is almost entirely `next dev` — the API call inside it is 2 ms.
Both numbers are meaningless as absolutes and useful only as the *before* column.

The plan is the real baseline:

```
Limit (actual time=0.050..0.055 rows=50 loops=1)
  Buffers: shared hit=7
  ->  Sort (actual time=0.049..0.051 rows=50 loops=1)
        Sort Key: updated_at DESC, id DESC
        Sort Method: quicksort  Memory: 29kB
        ->  Seq Scan on conversations (actual rows=63 loops=1)
              Filter: (org_id = 1)
              Rows Removed by Filter: 1
              Buffers: shared hit=1
Execution Time: 0.095 ms
```

`Seq Scan → Sort → Limit`. The planner ignores `conversations_org_id_idx` because at 64 rows
scanning the whole table is cheaper than an index. That is correct now and is exactly the
shape that stops being correct later. `count(*)` is a second `Seq Scan`.

### What breaks first at 2.5M rows — the guess, written down now

In order:

1. **`Sort` is the first casualty, and `LIMIT` will not save it.** Every one of the org's
   rows has to be read and sorted before 50 can be returned. The work scales with the size
   of the tenant, not the size of the page. This is a card 09 problem and the fix is
   `(org_id, updated_at DESC, id DESC)`, which lets the plan walk the index in order and
   stop at 50.
2. **`count(*)` becomes the slowest half of the response.** No shortcut exists under MVCC.
   It stays flat regardless of page size, so its share of the request grows as everything
   else gets fixed. Card 08.
3. **`OFFSET` degrades with depth, not with data.** Page 1 stays fast forever; page 10,000
   makes Postgres produce and discard 499,950 rows. This is the one that will surprise
   whoever finds it, because the endpoint will look fine in every test that reads page 1.
   Keyset pagination, card 08.
4. **Response size before anything else, if a sloppy caller ever sends `pageSize=100`
   repeatedly.** Serialising 100 rows to JSON is not free at volume, though it is far behind
   the other three.

Prediction on ordering: the `Sort` shows up first because it degrades for *every* user at
once, while `OFFSET` only hurts the few who page deep.
