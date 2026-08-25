# Drill 09 — Make the planner refuse your index

**Status:** shipped

Card: `memory-bank/progress.md`, Drill/09. Add status + date-range filtering to `GET /conversations`
and the page, design a composite index, then produce a query where the index exists and Postgres is
right to ignore it. Three plans, a selectivity threshold found empirically, and the column-order
reasoning written down *before* measuring — kept whether it was right or not.

It was not right. That is the most useful thing in this file.

---

## What shipped

- `status`, `updatedFrom`, `updatedTo` on `GET /conversations`, optional, no defaults.
- The same three on `/conversations` the page: status as links, the range as a `<form method="get">`.
  The route still ships no application JavaScript.
- Migration 005: `conversations_org_updated_idx ON conversations (org_id, updated_at DESC, id DESC)`,
  built `CONCURRENTLY`.
- `pnpm db:explain <plans|sweep|experiments|stats>` — the instrument, `apps/backend/db/explain.mjs`.
- 8 new e2e cases; suite 62 green. `pnpm db:test:naive` now fails **two** assertions, not one.

Everything below was measured on the whale (org 1: 1,000,000 of 2,500,000 conversations), page 1,
`pageSize=50`, after `VACUUM (ANALYZE) conversations`. Heap 198 MB / 25,392 pages;
`shared_buffers` 128 MB, undersized on purpose since drill 04.

---

## The column order I reasoned out before measuring

Kept verbatim. The index I intended to ship was **`(org_id, status, updated_at DESC, id DESC)`**:

1. `org_id` first — the only predicate present in *every* query this endpoint can produce. A btree
   prefix is usable only if the query constrains it, so the always-present column has to lead.
2. `status` second — equality, low cardinality, and **equality columns before range columns**: past a
   range boundary the index is no longer ordered by anything after it, so an equality placed later
   degenerates into a filter.
3. `updated_at DESC` third — the range *and* the sort. Third is where it can be both.
4. `id DESC` fourth — drill 03's tiebreaker, so the index covers the whole sort key and no Sort node
   is needed.

**Prediction, recorded before running anything:** swapping (1) and (2) to `(status, org_id, …)` will
barely move the whale's *filtered* query — both are still equalities over the same slice — but should
break the *unfiltered* query, which constrains `org_id` and not `status`.

### What actually happened

Half right, and wrong in the half that mattered.

The swap prediction's first clause held exactly: filtered queries were indistinguishable, 0.27 ms vs
0.27 ms. The second clause was **wrong** — the unfiltered query sequential-scans under *both* column
orders, because neither index can serve it:

```
  with-status (org_id, status, updated_at DESC, id DESC)  140 MB
    unfiltered no status, sort=updated_at      Seq Scan     115.36 ms
  swapped     (status, org_id, updated_at DESC, id DESC)  140 MB
    unfiltered no status, sort=updated_at      Seq Scan     115.81 ms
```

The reason is the thing rule (2) hides. Inside one org, a `(org_id, status, updated_at)` index is
ordered by **`status` first and `updated_at` second**. Ask for one org with no status filter and the
rows you want are split across two separate index ranges, each internally sorted, neither in the order
you asked for. Postgres has no loose/skip scan to stitch them back together, so it gives up and reads
the heap.

**"Equality before range" assumes the equality is always present.** `status` is optional. An optional
equality wedged between the tenant key and the sort key is dead weight for every request that omits
it — and the request that omits it is the *default page*, the one drill 05 baselined and the one
almost every user loads.

So the shipped index drops `status` out of the key entirely:

```
  shipped     (org_id, updated_at DESC, id DESC)  118 MB
    filtered   status=open, 7d, sort=updated_at       Index Scan   0.28 ms  buffers 18/0
    filtered   status=closed, wide, sort=updated_at   Index Scan   0.29 ms  buffers 26/0
    unfiltered no status, sort=updated_at             Index Scan   0.21 ms  buffers 17/0
```

`status` becomes a cheap recheck while walking `updated_at DESC` — plan B below shows it discarding
15 rows to find 50. It is 22 MB smaller and it is the only candidate that answers all three shapes.

Worth noting: `memory-bank/techContext.md` already named `(org_id, updated_at DESC, id DESC)` as the
missing index (drill 05's finding), while migration 001's comment named
`(org_id, status, updated_at DESC)`. The two records disagreed for four drills. The measurement
settles it in favour of the memory bank.

Command: `pnpm db:explain experiments`

---

## The three plans

`pnpm db:explain plans`. The "no index" arm is real: it drops the index inside a savepoint and rolls
back, which works because **DDL is transactional in Postgres**. That is what makes plan A reproducible
after the migration has landed.

### A — sequential scan (index dropped)

`status=closed`, whole 18-month window, `sort=updated_at`. 780,915 matching rows.

```
Limit  (cost=56737.10..56742.92 rows=50) (actual time=106.446..107.811 rows=50 loops=1)
  Buffers: shared hit=14644 read=10824
  -> Gather Merge  (Workers Launched: 2)
     -> Sort  Sort Key: c.updated_at DESC, c.id DESC
              Sort Method: top-N heapsort  Memory: 35kB
        -> Parallel Seq Scan on conversations c  (rows=324960) (actual rows=260305 loops=3)
              Filter: ((updated_at >= '2025-02-09…') AND (org_id = '1') AND (status = 'closed'))
              Rows Removed by Filter: 573028
Execution Time: 107.868 ms
```

**107.9 ms, 25,468 buffers** (14,644 hit + 10,824 read) — the entire 25,392-page heap, read to return
50 rows.

### B — index scan

`status=open`, last 7 days, `sort=updated_at`. 140,678 matching rows.

```
Limit  (cost=10.08..162.64 rows=50) (actual time=0.060..0.234 rows=50 loops=1)
  Buffers: shared hit=32
  -> Index Scan using conversations_org_updated_idx on conversations c
        Index Cond: ((org_id = '1') AND (updated_at >= '2026-08-04…'))
        Filter: (status = 'open')
        Rows Removed by Filter: 15
        Buffers: shared hit=18
Execution Time: 0.255 ms
```

**0.255 ms, 32 buffers. 423× faster than A on 796× fewer buffers.** No Sort node anywhere — the index
*is* the sort order. `Rows Removed by Filter: 15` is the whole cost of leaving `status` out of the key.

### C — the index is there and the planner refuses it

Same endpoint, **one query parameter different**: `sort=created_at`. `status=closed`, whole window.

```
Limit  (cost=56737.10..56742.92 rows=50) (actual time=114.148..115.372 rows=50 loops=1)
  Buffers: shared hit=14941 read=10527
  -> Gather Merge -> Sort  Sort Key: c.created_at DESC, c.id DESC
                           Sort Method: top-N heapsort  Memory: 37kB
     -> Parallel Seq Scan on conversations c
Execution Time: 115.619 ms
```

**115.6 ms — and the estimated cost is identical to plan A's, `56737.10..56742.92`, to the cent.** The
index is present, valid, and covers the entire `WHERE`. The planner priced using it and chose not to.

It is right. The index can answer the filter but cannot answer `ORDER BY created_at DESC`, which is not
in it. So the index path is "walk ~1M index entries in the date range, fetch every matching heap row at
random, sort 780,915 of them" against "read the heap once, sequentially, top-N sort". At 31% of the
table, sequential wins — and it is not close.

**This is the answer to the teammate who wants three more indexes.** The fix here is not a fourth
index for `created_at`; it is noticing that a whale-org default sort nobody asked for is what created
the problem.

---

## Where the planner flips

`pnpm db:explain sweep` — hold plan C's shape fixed, walk the `updatedFrom` cutoff, print the scan node
the planner chose. Every cutoff is anchored to `max(updated_at)` for the org, **not to `now()`**: the
seed's clock is frozen at 2026-08-11, so `now() - 7 days` selects nothing and would read as a
spectacularly selective filter.

| cutoff | matching | of org | **of table** | node | est rows | actual | ms |
|---|---|---|---|---|---|---|---|
| 548d | 780,915 | 78.1% | 31.2% | Seq Scan | 324,960 | 260,305 | 116.3 |
| 365d | 634,894 | 63.5% | 25.4% | Seq Scan | 278,062 | 211,631 | 101.2 |
| 180d | 427,220 | 42.7% | 17.1% | Seq Scan | 211,035 | 142,407 | 78.2 |
| 90d | 278,809 | 27.9% | 11.2% | Seq Scan | 161,288 | 92,936 | 62.7 |
| **66d** | **228,535** | **22.9%** | **9.1%** | **Seq Scan** | 143,461 | 76,178 | 56.2 |
| **65d** | **226,292** | **22.6%** | **9.1%** | **Seq Scan** | 142,631 | 75,431 | 52.1 |
| **64d** | **224,017** | **22.4%** | **9.0%** | **Bitmap Heap Scan** | 141,801 | 74,672 | 43.6 |
| 45d | 178,994 | 17.9% | 7.2% | Bitmap Heap Scan | 124,288 | 59,665 | 36.1 |
| 14d | 93,641 | 9.4% | 3.7% | Bitmap Heap Scan | 83,557 | 31,214 | 22.8 |
| 1d | 46,102 | 4.6% | 1.8% | Bitmap Heap Scan | 48,185 | 15,367 | 12.6 |

Found by bisection: `DAYS=90,88,86,85,84,83,82,81,80,78 pnpm db:explain sweep`, then `76…60`, then
`66,65,64`.

**The threshold is 9.0–9.1% of the table** (22.4–22.6% of the org). Below it the index is worth using;
above it the sequential read wins.

Does that match the rule of thumb? Yes, almost suspiciously well — the folklore number is "the planner
stops using an index somewhere around 5–10% of the table", and this landed at 9.05%. But the folklore
gets *why* wrong. It is not a threshold on the filter. It is the point at which the count of **random
heap fetches** the index path implies costs more than reading all 25,392 pages sequentially, and the
inputs to that are `random_page_cost` (4.0, the default, and wrong for an SSD), `effective_cache_size`,
the table's physical size, and the column's `correlation`. Change any of those and the "rule of thumb"
moves.

**There is never a plain `Index Scan` in that table.** The flip is `Seq Scan → Bitmap Heap Scan` and it
stops there. A bitmap scan sorts the matching heap pages into physical order before reading them —
which is exactly why it is cheaper than an index scan here, and also why it **destroys the index's
ordering** and cannot help the `ORDER BY` at all. The planner is buying the filter and paying for the
sort separately at every point on the ladder.

### The control that makes the point

Same sweep, `SORT=updated_at` — the sort the index *can* serve:

| cutoff | matching | of table | node | ms | buffers |
|---|---|---|---|---|---|
| 548d | 780,915 | 31.2% | Index Scan | 0.3 | 26 |
| 180d | 427,220 | 17.1% | Index Scan | 0.2 | 26 |
| 60d | 214,983 | 8.6% | Index Scan | 0.2 | 26 |
| 1d | 46,102 | 1.8% | Index Scan | 0.2 | 26 |

Flat. Index scan at **every** selectivity, including 78% of the org, at a constant 0.2–0.3 ms and a
constant 26 buffers.

**So the headline finding is that the selectivity threshold does not exist for this query shape.** When
the index provides the `ORDER BY` and there is a `LIMIT`, selectivity is irrelevant: the scan walks 50
entries and stops, and it does not matter whether 46,000 or 780,000 rows would have qualified. The
5–10% rule only governs queries that must *materialise* their matches. Half the arguments about
"is this selective enough to index" are asking a question their query does not have.

Command: `SORT=updated_at pnpm db:explain sweep`

---

## Estimated vs actual rows

The card asks for this on every plan, and it is where the two most interesting errors live.

| plan | estimated | actual | error |
|---|---|---|---|
| A / C (`status=closed`, wide) | 974,880 (324,960 × 3 workers) | 780,915 | **+24.8% over** |
| B (`status=open`, 7d) | 46,173 | 140,678 | **−67% under, 3.0× out** |

Both come from the planner assuming the three predicates are **independent** and multiplying their
selectivities. They are not independent — `seed.mjs` closes conversations on an exponential decay in
age, so `status` and `updated_at` are strongly correlated by construction. Recency and open-ness
travel together, in the seed exactly as in a real support inbox.

`pg_stats` shows the planner's raw inputs (`pnpm db:explain stats`):

```
  status      n_distinct 2        mcv {closed,open}   mcf {0.7802,0.2198}   correlation 0.9771
  org_id      n_distinct 200      mcv {1,10,5,…}      mcf {0.3999,…}        correlation 0.1743
  updated_at  n_distinct 186169   mcv {2026-08-11}    mcf {0.1288}          correlation 0.9980
  created_at  n_distinct -0.9945                                            correlation 1.0000
```

78.02% closed × 39.99% org 1 × the date fraction is exactly the arithmetic that produced the numbers
above. The fix Postgres offers is `CREATE STATISTICS … (dependencies)` on `(status, updated_at)`; it is
not in scope here and is the obvious follow-up.

Two things to read off that dump rather than guess:

- **`n_distinct` is negative when it is a ratio.** `created_at`'s `-0.9945` means 99.45% of rows have a
  distinct value, not "minus one distinct value". Positive numbers are counts. It is the single most
  misread field in the view.
- **`correlation 1.0000` on `created_at`** — the table is physically stored in `created_at` order,
  because drill 04's seed sorted by it before `COPY`. That would make a `created_at` index extremely
  cheap. It does nothing for us: correlation only pays off when there *is* an index, and plan C is
  precisely the case where there isn't.

---

## What BUFFERS said that timing did not

Timing says plan A is slow. Buffers say *why*, and say two further things timing cannot.

**1. It separates "fast" from "cached".** Plan A reads 25,468 buffers to return 50 rows — the whole
heap. Across sweep runs the same query moved between `1584 hit / 23808 read` and `15308 hit / 10084
read` while wall-clock barely moved. Same work, different cache state. A benchmark that reports only
milliseconds cannot tell you which of those two runs you are looking at, which is how "the index made
it faster" gets claimed for a run that was simply warm. Plan B's 32 buffers, all hits, are not fast
because they were cached — there are only 32 of them.

**2. It shows the bitmap flip paying for itself in I/O, not CPU.** Watch `read` collapse at the
threshold in the sweep: `15,933 hit / 9,459 read` at 66d, then `14,218 hit / 0 read` at 64d. The
sequential scan is *forced* to evict and re-read against a 128 MB `shared_buffers` because it touches
198 MB of heap every time. The bitmap scan touches a subset small enough to stay resident. Wall clock
records a 52 ms → 44 ms improvement; buffers record 9,459 physical reads → zero, which is the actual
mechanism and the one that would scale differently on other hardware.

**3. It exposes the planner's own cost.** `Planning: Buffers: shared hit=235 read=15` on plan A —
planning is not free, it reads catalogue and statistics pages. At 0.6 ms against a 108 ms execution
nobody cares; on plan B it is 0.389 ms of planning against 0.255 ms of execution, i.e. **the planning
costs more than the query**. That is the argument for prepared statements, and it is invisible without
`BUFFERS`.

---

## Stretch — the partial index

`(org_id, updated_at DESC, id DESC) WHERE status = 'open'`, built and rolled back in one transaction:

| index | size | vs heap | open/7d | closed/wide | unfiltered |
|---|---|---|---|---|---|
| shipped `(org_id, updated_at, id)` | **118 MB** | 59.6% | Index Scan 0.28 ms | Index Scan 0.29 ms | Index Scan 0.21 ms |
| partial `… WHERE status='open'` | **26 MB** | 13.1% | Index Scan 0.26 ms | **Seq Scan 105.20 ms** | **Seq Scan 119.88 ms** |
| `(org_id, status, updated_at, id)` | 140 MB | 70.8% | Index Scan 0.27 ms | Index Scan 0.25 ms | **Seq Scan 115.36 ms** |

**Decision: do not ship it.** The size number is genuinely attractive — 26 MB against 118, a 4.5×
saving, and it lands near the 21.98% open share exactly as the seed's design predicted it would (the
seed correlates status with age *specifically* so this measurement is not flattered). But it is 26 MB
of write amplification, vacuum surface and planning-time candidates that buys **0.02 ms** on the one
query it serves, and answers neither of the other two. The shipped index already does all three at
0.2–0.3 ms.

A partial index earns its place when it is the *only* index — a small hot slice of a huge cold table,
where the full index would not fit in cache. Here the full index is 118 MB and the machine has enough
memory for it. Wrong tool, right instinct, and now with a number attached.

**Related, and a decision for the user, not taken here:** `conversations_org_id_idx` (17 MB) is now
redundant. `(org_id, updated_at DESC, id DESC)` has `org_id` as its leading column, so every query the
single-column index can answer, the composite can answer too. It is 17 MB and a write cost on every
insert, buying nothing. Dropping it is the right call; it is a judgment, so it is proposed rather than
done.

---

## Method notes, and what would invalidate this

- **Every plan runs under RLS.** `db/explain.mjs` connects as the owner (it needs DDL, and `pg_stats`
  hides RLS-enabled tables from non-owners) and then `SET LOCAL ROLE`s into `app_user` per transaction.
  Measured as `postgres`, every plan here would be missing the policy predicate. Drill 07's
  `STABLE PARALLEL SAFE` work shows up as the `One-Time Filter` line at the top of every plan —
  evaluated once, not per row.
- **Bind parameters, not interpolated literals**, because that is how the application sends them. A
  one-shot unnamed statement always gets a *custom* plan; generic plans need a named prepared statement
  executed five times, and can differ.
- **These are single-connection numbers.** Drill 08 established that on this box a 10-VU k6 run against
  the whale has a 14–17% within-arm spread, which is wider than several effects in this file. That is
  why there is no k6 arm here: the isolated `EXPLAIN` is the right instrument for "which plan did it
  choose", and the wrong one for "what does the endpoint do under load".
- **`random_page_cost` is 4.0**, the default, which models a spinning disk. On an SSD the honest value
  is nearer 1.1, and every threshold in this file would move down with it. The 9.05% is a fact about
  *this configuration*, not about Postgres.

### Things that went wrong, kept because they teach

1. **`max(updated_at)` came back `NULL`.** The script read the table before opening the tenant scope,
   so `app_current_org()` was NULL and the policies filtered every row away. The mechanism working, and
   a good reminder that fail-closed looks like empty data, not like an error.
2. **`pg_stats` returned zero rows** as `app_user` — the view hides statistics for RLS-enabled tables
   from non-owners. Silent, no error. Nearly recorded as "this table has no statistics".
3. **`must be owner of index`** — the app role cannot drop the index it uses, hence the
   `SET LOCAL ROLE NONE` / `SET LOCAL ROLE app_user` dance around the DDL.
4. **A test written expecting a 400 came back 200.** `updatedTo=20260615` is the ISO 8601 *basic*
   format, which `@IsISO8601` accepts and Postgres parses identically. Kept as a passing test — the
   validator rejects what the standard rejects, not what I imagined.

---

## Card questions, answered

**Why that column order, and what happens if you swap the first two?**
Above. The order I shipped is not the order I reasoned my way to: `org_id` leads because it is the only
always-present predicate; `updated_at DESC` is second because it is the range *and* the sort and needs
to be adjacent to the leading equality; `id DESC` closes the sort key. Swapping the first two of the
*four*-column version changes nothing measurable — both are equalities over the same slice — which is
itself the finding: the interesting question was never the first two columns, it was whether `status`
belonged in the key at all. It did not.

**At what selectivity did the planner flip, and does that match the rule of thumb?**
9.0–9.1% of the table, `Seq Scan → Bitmap Heap Scan`. It matches the 5–10% folklore closely and for
reasons the folklore does not state — it is a threshold on random heap fetches versus a sequential
read, not on the filter. And for the query shape that actually matters here (`ORDER BY` served by the
index, plus a `LIMIT`), no threshold exists at all: the index wins at 78% selectivity.

**What did BUFFERS tell you that timing alone didn't?**
That plan A reads the entire 198 MB heap to return 50 rows; that identical wall-clock times hide
completely different cache states, so a milliseconds-only benchmark cannot tell a real improvement from
a warm run; that the bitmap flip is an I/O win (9,459 physical reads → 0) rather than a CPU one; and
that plan B spends more time planning than executing.
