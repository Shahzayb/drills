# Drill 11 — Full-text search over 10M messages with a GIN index, measured against LIKE

Card 11. The drill is not "GIN is faster than LIKE" — it is that an index type is chosen by query
shape, that the winner in the general case loses in specific cases a product owner cares about, and
that the two mechanisms this repo already shipped, row-level security and a deliberately unindexed
`org_id`, both turned out to decide the answer.

**Status:** shipped

---

## What shipped

- `messages.tsv`, a `tsvector` generated column, and `messages_org_tsv_idx`, a
  `gin (org_id, tsv)` built with `btree_gin` — migrations `1787997600000` and `1787997900000`.
- `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF` — migration `1787998200000`, and
  without it none of the above is reachable at all. This is the finding of the card.
- `GET /messages/search?q=&limit=`, one statement, `@QueryBudget(1)`, behind
  `SEARCH_STRATEGY=like|fts` with `fts` the default. Its own route rather than a `q` on
  `GET /conversations`, for the reason in `search.controller.ts`.
- `/search`, a zero-JavaScript RSC page with a GET form.
- `pnpm db:search <plans|indexes|gaps|writes>` and `k6/messages-search.js`.
- `pnpm db:test:like`, an expected-failure suite in the shape of `db:test:naive`.
- Suite 83 green (was 73). `db:test:like` fails exactly one assertion.

Conditions for every number below: Postgres 18.6, `shared_buffers=128MB`, `work_mem=4MB`,
`maintenance_work_mem=64MB` at the server and `512MB` inside `db:search indexes`,
`max_parallel_workers_per_gather=2`, `VACUUM (ANALYZE) messages` after the migrations, whale org 1
(3,995,594 messages) and tail org 150 (10,209), medians of five with the first run discarded.

---

## Predictions, and what happened

| Predicted | Measured |
|---|---|
| GIN beats LIKE by ~100× | 162× on a 0.045% term, **11.3×** on a 4.1% one. Both are the truth. |
| `GGY` is where FTS loses to LIKE | FTS *wins*. LIKE's extra 1,726 rows are the name "Peggy". |
| `ERR_24` is an unfixable FTS gap | Fixable — `to_tsquery('err_24:*')` returns the same 18,383 rows. |
| The GIN index is the expensive part | The **column** is 2,422 MB and the index is 426 MB. |
| Tenant scoping in the GIN key is a nicety | **1,983×** on the tail org, for 16 MB — and it accidentally became the `org_id` index `messages` never had. |
| — | Not predicted at all: RLS makes the planner unable to *see* the index. |

---

## The finding: RLS switched the index off

The first `db:search plans` run, with the index built, valid and analysed, produced a sequential
scan on every FTS row. Not a bad cost estimate — no index path at all:

```
SET enable_seqscan = off;
->  Parallel Seq Scan on messages m
      Disabled: true
      Filter: ((org_id = 1) AND (tsv @@ '''err'' <-> ''2452'''::tsquery))
```

`Disabled: true` and still chosen means the planner had nothing else to choose.

An RLS policy becomes a *security qual* that must be evaluated before any ordinary qual, and an
ordinary qual may only be promoted past it into an index condition if it is leakproof.

```sql
SELECT p.proleakproof FROM pg_operator o JOIN pg_proc p ON p.oid = o.oprcode
 WHERE o.oprname = '@@' AND o.oprleft = 'tsvector'::regtype;
-- f
```

So drill 07's tenant policy is what switched drill 11's index off. Neither half is wrong on its own,
and neither half mentions the other anywhere.

`ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF` is the fix, and it is a real security
decision rather than a tuning flag — the operator now runs against rows the policy would otherwise
have removed first. Migration `1787998200000` carries the argument. **The alternative is a 3.6-second
search box.**

## The numbers

```
pnpm db:search plans            # org 1
ORG_ID=150 pnpm db:search plans # org 150
```

**Whale org 1, 3,995,594 messages:**

| term | arm | scan node | matches | median ms | hit/read |
|---|---|---|---|---|---|
| `export` | like | Seq Scan | 164,508 | 3,315.57 | 15623/651454 |
| `export` | **fts** | **Bitmap Heap Scan** | 164,508 | **292.68** | 1299/144664 |
| `export` | fts, not leakproof | Seq Scan | 164,508 | 3,451.74 | 15909/651168 |
| `export` | fts, no gin | Seq Scan | 164,508 | 3,365.72 | 15882/651195 |
| `ERR_2452` | like | Seq Scan | 1,807 | 3,676.11 | 15894/651183 |
| `ERR_2452` | **fts** | **Bitmap Heap Scan** | 1,807 | **22.65** | 1015/2735 |
| `ERR_2452` | fts, not leakproof | Seq Scan | 1,807 | 3,609.55 | 14956/652121 |
| `ERR_2452` | fts, no gin | Seq Scan | 1,807 | 3,627.02 | 14937/652140 |

**11.3× on the common term, 162× on the rare one.** The gap between those two is the honest answer
to "how fast is full-text search": `export` matches 4.1% of the org, and a GIN bitmap of 164,508 rows
still has to fetch 164,508 heap rows and top-N sort them, because GIN returns no ordering. The index
removes the scan, not the work.

Both keys reach the index once the operator is leakproof:

```
->  Bitmap Index Scan on messages_org_tsv_idx
      Index Cond: ((org_id = '1'::bigint) AND (tsv @@ '''err'' <-> ''2452'''::tsquery))
```

**Tail org 150, 10,209 messages — and it disagrees:**

| term | arm | scan node | matches | median ms |
|---|---|---|---|---|
| `export` | like | Bitmap Heap Scan | 424 | 13.75 |
| `export` | fts | Bitmap Heap Scan | 424 | **2.45** |
| `export` | fts, not leakproof | Bitmap Heap Scan | 424 | 3.32 |
| `export` | fts, no gin | Seq Scan | 424 | 4,427.70 |
| `ERR_2452` | like | Bitmap Heap Scan | 4 | 16.53 |
| `ERR_2452` | fts | Bitmap Heap Scan | 4 | 8.72 |
| `ERR_2452` | fts, not leakproof | Bitmap Heap Scan | 4 | 3.60 |
| `ERR_2452` | fts, no gin | Seq Scan | 4 | 3,436.63 |

Two things here that the whale org cannot show.

**The LIKE arm got an index.** `message ILIKE '%export%'` can use no index at all, and yet the tail
org's LIKE arm is a Bitmap Heap Scan at 13.75ms instead of a 4.4-second scan. The bitmap is on
`org_id`, out of the *search* index's leading key. Migration 001 left `messages.org_id` unindexed on
purpose; `gin (org_id, tsv)` is now, incidentally, that index. A 322× improvement to the arm this
card was supposed to be replacing.

**`not leakproof` is sometimes faster here.** With four matching rows, an org_id-only bitmap over
10,209 fully cached rows (`3122/0` — every buffer a hit) beats a two-key GIN scan that reads 382
blocks from disk. At this size the numbers are cache effects, and a 5ms difference on a tail org is
not a finding.

---

## Under load, the gap is much wider than one query suggests

```bash
Q=export NAME=fts  node k6/run-baseline.mjs messages-search.js
SEARCH_STRATEGY=like docker compose up -d nest_server
Q=export NAME=like node k6/run-baseline.mjs messages-search.js
```

10 VUs, closed loop, 20s warm-up discarded, 60s measured, org 1, `q=export`:

| arm | p50 | p95 | p99 | throughput | requests |
|---|---|---|---|---|---|
| fts | **16.51 ms** | 44.30 ms | 66.71 ms | **442.10 req/s** | 26,526 |
| like | 7,811.23 ms | 24,705.01 ms | 24,993.52 ms | **1.12 req/s** | 67 |

**395× throughput, against 11.3× for the same query measured one at a time.** A single `EXPLAIN
ANALYZE` understates the LIKE arm's real cost badly: ten concurrent sequential scans of the same
2.4 GB heap contend for the same disk and the same `shared_buffers`, so a 3.3-second query becomes
a 7.8-second p50 and a 24.7-second p95. Drill 08 found the same shape from the other direction —
concurrency is what turns a per-request cost into an outage.

Caveat worth stating: the LIKE arm completed **67 requests in 60 seconds**. Its percentiles are
computed over 67 samples and should be read as "tens of seconds", not as three significant figures.

---

## What it cost on disk

```
pnpm db:search indexes
```

| | before | after |
|---|---|---|
| `messages` heap | 2,619 MB | **5,212 MB** |
| `messages` indexes | 363 MB | 789 MB |
| total relation size | 2,984 MB | **6,001 MB** |

The table doubled, and the GIN index is not why. Per row, over a 50,000-row sample of org 1:

```sql
SELECT avg(pg_column_size(message))::int, avg(pg_column_size(tsv))::int, avg(length(tsv))::int
  FROM (SELECT message, tsv FROM messages WHERE org_id = 1 LIMIT 50000) s;
-- 189 bytes | 253 bytes | 18 lexemes
```

**The derived column is 134% of the text it derives from.** 18 lexemes per 189-byte message, each
carrying its own positions. `strip()` would drop the positions and most of the size, at the cost of
phrase search — not done, and named under "deliberately not done".

Build times, both stated with their `maintenance_work_mem` because a build time without one is not a
number:

| what | how | mwm | time |
|---|---|---|---|
| `ADD COLUMN tsv ... STORED` | full table rewrite, `ACCESS EXCLUSIVE` | — | **135 s** |
| `messages_org_tsv_idx` | `CREATE INDEX CONCURRENTLY` | 64 MB | **58 s** |
| the same index | plain `CREATE INDEX`, in a rolled-back txn | 512 MB | 21.2 s |

135 seconds of `ACCESS EXCLUSIVE` on `messages` is an outage, not a migration, and the generated
column bought it. See "the defence" below.

```
pnpm db:search indexes                        # org 1
ONLY=gin ORG_ID=150 pnpm db:search indexes    # org 150, skipping the 1,959 MB btrees
```

Each candidate is built in **its own transaction, with the shipped index dropped**, probed, and
rolled away. `maintenance_work_mem = 512MB`, so the five are comparable to each other.

**Whale org 1, probe term `export`:**

| candidate | build s | size | scan node | median ms |
|---|---|---|---|---|
| `gin (org_id, tsv)` | 18.4 | **426 MB** | Bitmap Heap Scan | **310.12** |
| `gin (tsv)` | 17.6 | 410 MB | Bitmap Heap Scan | 606.56 |
| `btree (message)` | 24.1 | **1,959 MB** | Seq Scan | 4,457.57 |
| `btree (message text_pattern_ops)` | 16.4 | 1,959 MB | Seq Scan | 4,445.22 |
| `gin (message gin_trgm_ops)` | 125.5 | **2,159 MB** | Seq Scan | 4,379.76 |

**Tail org 150, same term:**

| candidate | size | scan node | median ms |
|---|---|---|---|
| `gin (org_id, tsv)` | 426 MB | Bitmap Heap Scan | **2.57** |
| `gin (tsv)` | 410 MB | Bitmap Heap Scan | **5,098.05** |
| `gin (message gin_trgm_ops)` | 2,159 MB | Seq Scan | 3,850.05 |

Three readings.

**The tenant key costs 16 MB and is worth 1,983× on the tail org.** `gin (tsv)` is 3.9% smaller and
1.96× slower on the whale; on org 150 it is a 412,290-row bitmap across every tenant, lossy at
`work_mem=4MB` (`Rows Removed by Index Recheck: 1,192,116`), filtered down to 424 rows. This is the
strongest argument in the drill for `btree_gin`.

**`btree (message)` is 1,959 MB — 4.6× the GIN — and serves nothing.** That is the card's question
answered by measurement: the reflex index is the biggest one here except the trigram, and the query
is a sequential scan with it in place.

**The trigram index is 2,159 MB and takes 125 s to build**, 6.8× the GIN's build, and under RLS it is
unreachable anyway — `texticlike` is non-leakproof, so `ILIKE` gets no index condition either. Buying
interior-substring search would mean a second `ALTER FUNCTION ... LEAKPROOF` on top of the disk and
the write cost.

### What the B-tree can and cannot serve

The last part of `db:search indexes` runs two queries against one `text_pattern_ops` btree, **as the
owner with no RLS in the way**, so the structural question is separated from the leakproof one.
`count(*)` rather than `LIMIT 20`, because a `LIMIT` with no `ORDER BY` lets a sequential scan stop
at the twentieth match and never finish the work.

Read the plan, not the clock. With the btree present, `LIKE 'Thanks%'` compiles the prefix into a
range on the index:

```
Index Cond: ((message ~>=~ 'Thanks'::text) AND (message ~<~ 'Thankt'::text))
```

`LIKE '%Thanks%'` produces **no index condition at all** — there is nothing to descend to, so the
only correct plan reads every row.

The timings do not separate them, and that is drill 09 arriving again rather than a contradiction:
`Thanks` opens 83,571 of the whale org's messages, ~3% of the table, which is past the point where
the planner prefers scattered index fetches over a parallel sequential read. It declines the btree
on cost (5,621 ms) and scans (4,086 ms). **A prefix is indexable; that does not make it worth
indexing at 3% selectivity.**

The trigram index, on the same probe, does what the tsvector cannot:

```
->  Bitmap Index Scan on trial_gin_trgm
      Index Cond: (message ~~ '%xport%'::text)   -- 412,290 rows
```


---

## Where FTS answers worse than LIKE

```
pnpm db:search gaps
```

| input | like rows | fts rows | verdict | tsquery |
|---|---|---|---|---|
| `ERR_24` | 18,383 | 0 | closable with `:*` | `'err' <-> '24'` |
| `expor` | 164,508 | 0 | closable with `:*` | `'expor'` |
| `xport` | 164,508 | **0** | **FTS worse, no fix** | `'xport'` |
| `fund` | 177,285 | **0** | **FTS worse, no fix** | `'fund'` |
| `GGY` | 2,254 | 528 | FTS *better* | `'ggi'` |
| `refunds` | **0** | 177,285 | FTS better | `'refund'` |
| `csv export` | 70,044 | 70,044 | agree | `'csv' & 'export'` |
| `"csv export"` | 70,044 | 70,044 | agree | `'csv' <-> 'export'` |

**The only real gap is the interior substring.** A prefix names a place in the lexeme index the same
way it names a place in a btree, so `to_tsquery('expor:*')` recovers all 164,508 rows and
`to_tsquery('err_24:*')` recovers all 18,383. `xport` and `fund` name nothing, and `:*` does not help
them — 0 rows either way. That is the same structural reason a btree cannot serve `LIKE '%term%'`,
one level down.

**Two of the predicted gaps are wins.** `refunds` finds 177,285 rows containing *refunded*; ILIKE
finds none, because the substring "refunds" does not occur in "refunded". And the identifier case
inverts:

```
Peggy       1,072 rows
Peggyfort     654 rows
GGY-5178      528 rows
```

Three quarters of what `LIKE '%GGY%'` returns is a person's name. A lexeme knows where a word ends.

**What I would tell the product owner.** Search is word-based: it finds *refunded* when you type
*refunds*, it will not find *fund* inside *refunded*, and it does not do "contains". Ticket
references need an exact-lookup field, which is an indexed equality query and not a search problem.
Prefix (type-ahead) is supportable and is not built here — see below.

**The rejected index, priced.** `gin (message gin_trgm_ops)` answers `xport` and `fund` correctly.
Its numbers are in the table above, measured inside a rolled-back transaction so the extension is not
left installed. It is not shipped: it roughly doubles the write cost measured in the stretch, for a
query class the product can be talked out of.

---

## Stretch — is search costing you writes?

```
pnpm db:search writes
```

```
pnpm db:search writes
```

Three interleaved rounds, 50,000 rows per `COPY` and 2,000 single-row `INSERT`s per arm, each round
starting from the same table state, everything rolled back at the end. Medians, raw rounds in
brackets:

| arm | rows/s | rounds |
|---|---|---|
| `COPY`, gin present | 31,766 | 26,999 / 33,373 / 31,766 |
| `COPY`, gin dropped | **41,586** | 43,812 / 33,541 / 41,586 |
| `INSERT`, gin present | 6,812 | 5,636 / 6,812 / 8,342 |
| `INSERT`, gin dropped | **8,614** | 8,614 / 8,405 / 8,821 |

**`COPY` is 1.31× and `INSERT` 1.26× faster without the GIN index.** So yes, search is costing
writes — about a quarter to a third of insert throughput. The index grows 2.9 MB per 50,000 rows
(~61 bytes a row).

Two things that stop that being the whole answer:

- **Both arms build the tsvector.** `tsv` is a generated column, so dropping the index does not
  avoid parsing and stemming. `to_tsvector` over the same 50,000 bodies is **636 ms** on its own,
  against a ~370 ms difference between the two `COPY` arms — the column costs more than the index it
  feeds.
- **The pending list defers part of the bill.** `fastupdate` is on and `gin_pending_list_limit` is
  4MB, so new entries are buffered and merged later. `gin_clean_pending_list()` on the index after
  one `COPY` moved **94 pages in 43 ms**, which is work the `COPY` number above did not pay for.

**The first version of this measurement was not a measurement.** Both arms ran once, in order, and
reported 1.02× for `COPY` and 1.07× for `INSERT`. An immediate re-run of the same code reported
1.36× and 3.31×. The arm that runs first pays for cold state and the rolled-back rows of one arm
change the next, so the arms are now interleaved with a savepoint reset per round, the same rule
`paging.mjs` follows. Single-shot write benchmarks on this table are noise.


---

## Method notes, and what would invalidate this

- Every number is one laptop, one Docker Postgres, `shared_buffers` deliberately 128MB against a
  5,212 MB heap so cache misses stay visible. Raising `shared_buffers` past the heap would make the
  LIKE arm look far better and the whole comparison narrower.
- The corpus is template-generated support prose with a fixed vocabulary. There is **no genuinely
  rare English word in it** — the ladder runs 6.5% down to 0.015%, and the low end is an error code
  rather than a word. A real corpus has a long tail this one does not.
- Medians of five with the first discarded. The tail org's numbers are all inside one cache; treat
  differences under ~5ms there as noise.
- `db:search indexes` builds with `maintenance_work_mem=512MB` so the five candidates are comparable
  to each other. The shipped index's real build time was measured separately, by the migration, at
  the server's 64MB.
- What would invalidate it: a different `default_text_search_config`, a corpus with different
  average length, or `fastupdate=off` on the index.

### Things that went wrong, kept because they teach

1. **The whole first `plans` run measured a sequential scan** and looked like "FTS is barely faster
   than LIKE". The index was present and valid the entire time. Chasing `indisvalid` first was
   wasted effort; `SET enable_seqscan = off` was the question worth asking, because a *disabled* seq
   scan that still wins means there is no other path, which is a different problem from a costing
   problem.
2. **`org_id = 150` did not reach the index and `org_id = 150::bigint` did.** btree_gin's `int8_ops`
   opfamily contains only `bigint = bigint`; there are no cross-type members, so an `integer` literal
   silently drops the tenant key out of the index condition. The application is safe by accident —
   `pg` sends the org id as an untyped parameter that resolves to `bigint` — but every hand-written
   `EXPLAIN` in psql was measuring a different plan from the one the service runs, and produced a
   7.3-second tail-org result that had nothing to do with the endpoint.
3. **The `GGY` prediction was backwards.** It was written down as the "FTS is worse" case and
   measured as an FTS win. Kept in the gaps table with the Peggy breakdown, because a prediction
   table where every row was right is a table that was written afterwards.
4. **`db:search indexes` ended on `COMMIT` at first**, which would have left `pg_trgm` installed by
   the mode whose purpose is to argue against installing it. It ends on `ROLLBACK` now.
5. **`db:search indexes` priced every candidate with the shipped index still in place.** The
   planner simply used the better of the two, or `BitmapAnd`ed them together, so each row reported
   `messages_org_tsv_idx`'s number under the candidate's name — `gin (tsv)` came out 1.19× off the
   composite on the tail org, which is not a comparison at all. The candidate loop now runs inside
   `withoutIndex`.
6. **The `text_pattern_ops` demonstration first probed `LIKE 'export%'`**, and nothing in the corpus
   starts with "export". It measured a 0-row scan and read like the index had failed. Every message
   opens with one of ~18 templates; `LIKE 'Thanks%'` matches 83,571 of them.
7. **The write benchmark leaves the heap inflated.** Its rolled-back `COPY`s are dead tuples, so
   `pg_relation_size('messages')` reads 5,584 MB afterwards against the 5,212 MB measured right
   after the migration and `VACUUM (ANALYZE)`. The 5,212 MB figure is the one quoted above; the
   number `db:search indexes` prints will be higher until autovacuum catches up.

---

## Writeup — the card's questions

### Why can't a B-tree serve `LIKE '%term%'`?

A btree is sorted by the whole string from the left, so a lookup is "descend to the subtree whose
keys start this way". A leading wildcard names no prefix, so there is no subtree to descend into and
the only correct answer is to read every leaf. Demonstrated rather than asserted in `db:search
indexes`: one `btree (message text_pattern_ops)`, two queries — it serves `LIKE 'export%'` and
refuses `LIKE '%export%'`.

A GIN index is not sorted by the value at all. It is a dictionary of lexemes, each pointing at a
posting list of row pointers, so "which rows contain this word" is one lookup regardless of where in
the string the word sits. Different question, different structure.

### What did the GIN index cost in disk and write throughput?

426 MB of index — and 2,422 MB of stored `tsvector` column to make it possible, which is the larger
half and the one nobody budgets for. Write throughput is in the stretch table above.

### What did you do about the queries FTS handles worse, and what did you decide not to support?

Prefix is closable with `:*` and is described but not built. Interior substrings (`xport`, `fund`)
are not supportable without a trigram index, which is priced and rejected. Exact identifier lookup
belongs in its own column with a btree on it. Everything else — plurals, tenses, phrases, negation
via `websearch_to_tsquery` — the FTS arm already does better than LIKE did.

---

## Deliberately not done

- **`ts_rank` relevance ordering.** Results are newest-first. Ranking needs the whole match set
  materialised before the sort, which is the 164,508-row problem above and deserves its own
  measurement.
- **Type-ahead / `:*` prefix queries.** Measured in `db:search gaps`, not wired to the endpoint:
  `websearch_to_tsquery` cannot emit `:*`, so it needs a hand-built tsquery and a decision about
  what happens to the other terms.
- **`strip()`ing positions out of the stored tsvector.** Would cut most of the 2,422 MB and remove
  phrase search. Worth measuring; not measured.
- **Highlighting (`ts_headline`).** It re-parses the document per row and is a per-row cost on the
  page, not on the index.
- **`fastupdate=off`, `gin_pending_list_limit` tuning.** Named in the stretch, not swept.
- **Paging the search results.** `limit` only, no cursor. Drill 10's fingerprint problem is exactly
  why search is not on the list endpoint, and giving it its own cursor is its own piece of work.
