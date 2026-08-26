# Drill 10 — Replace OFFSET with keyset pagination, chart the difference, ship the UI

**Status:** in progress

Card 10. `GET /conversations` has paged with `LIMIT`/`OFFSET` since drill 03, where it was naive
*on purpose*. Drill 09's index made **page 1** fast and left deep pages exactly where they were:
`OFFSET 20000` still makes Postgres produce and discard 20,000 rows before returning yours.

Drill 03 predicted this and the prediction is still open — *"page 1 stays fast forever; page
10,000 makes Postgres produce and discard 499,950 rows… the endpoint will look fine in every test
that reads page 1."*

The drill is not "keyset is faster". It is what keyset **cannot** do (jump to page 40, report
`total`), what breaks when the sort key is not unique, and what each version does when a row is
inserted mid-pagination.

---

## What gets built

- `paging=offset|keyset` and `cursor` on `GET /conversations`. Offset is the default and is
  **kept permanently** — it is the A/B's other arm and the only way to do "jump to page 40".
- Keyset page: row-comparison predicate `(sort_col, id) < ($k, $i)`, `LIMIT pageSize + 1`,
  **no count query**. Returns `nextCursor`/`hasMore`, no `total`/`totalPages`.
- An **opaque** cursor (base64url JSON) carrying `v`, the key values, and a query-shape
  fingerprint — the stretch goal.
- `KEYSET_TIEBREAK=off`, a module-load arm that drops `id` from the predicate, and the e2e case
  that goes red under it. `pnpm db:test:notiebreak`.
- Load-more UI: first page still server-rendered, a `"use client"` list appends via a new Next
  Route Handler. `?mode=offset` keeps the numbered pager.
- `pnpm db:paging <depths|walk|concurrent>` and `pnpm db:explain keyset`.

**No migration.** Drill 09's `conversations_org_updated_idx (org_id, updated_at DESC, id DESC)` is
already the right shape for keyset on `updated_at`. `sort=created_at` has no index for its
ordering and is the counter-example that stops "keyset is fast" being learned as magic.

---

## Predictions, recorded before measuring

Drill 09's most useful section was the one that kept a wrong prediction. Same here.

1. Offset latency will be roughly **linear in depth**, not flat-then-cliff — the index scan walks
   and discards `OFFSET` entries, it does not re-plan.
2. Keyset will be **flat within noise** across all five depths on `sort=updated_at`.
3. `(a, b) < (x, y)` **will** fold into a single `Index Cond` on the `DESC, DESC` index. Least
   confident of the three; if it does not, that is the finding and it gets written down.
4. Offset at depth will still beat a **seq scan**, because drill 09's index serves the ordering —
   so the curve climbs from ~0.25 ms, not from ~108 ms.
5. The tail org (150, 2,631 rows) will show **almost no offset penalty** at any reachable depth.
   Deep paging is another whale-only problem, like every other one in this repo.

---

## Decisions

*(filled in as the work lands)*

## The chart

*(pnpm db:paging depths — filled in after measuring)*

## The concurrent-insert trace

*(pnpm db:paging concurrent — filled in after measuring)*

## Writeup

*(the card's four questions — filled in at the end)*
