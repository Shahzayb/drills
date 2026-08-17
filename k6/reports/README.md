# k6 reports

One directory per run, named for everything that changes the measurement:

```
2026-08-14-080122-<name>-conversations-baseline-org150-vus10-60s/
  dashboard.html   k6's web dashboard — 170KB, generated, **gitignored**
  summary.txt      the block the run printed, verbatim — ~300 bytes, committed
```

The dashboard is worth *generating*: percentiles are a single point in time and only the time
series separates a uniformly slow run from one that stalled for five seconds. It is not worth
committing — twelve of them was 2MB of HTML, and every number a plan file cites is in the summary,
including the `RESULT,` line for pasting into a table.

So: read the HTML while the run is fresh, keep the summary forever.

The name records `org`, `vus` and `duration`, and — since 2026-08-14 — an optional arm label from
`NAME=<label> pnpm load:baseline`, which lands right after the timestamp. A label is a hint, not
the record: it is empty by default, and it cannot say what `tracing-off` meant three weeks later. A
run nobody can map back to a condition is not evidence. So: keep the runs a plan actually cites,
and index them here.

## What is here

| run | what it was |
|---|---|
| `2026-08-13-1535/1548/1550-org1` | drill 05, whale baseline, 3 runs. Medians in `plans/2026-08-13_drill-05-load-test-baseline.md`. |
| `2026-08-13-1606/1609/1612-org15` | drill 05 era, org **15** — a mid-size org that matches no table in any plan file. Kept as committed; treat as exploratory, not a baseline. |
| `2026-08-14-080122-org150` | drill 06 phase 2 A/B — round 1, tracing **off** |
| `2026-08-14-080303-org150` | round 1, tracing on, **100%** sampled |
| `2026-08-14-080444-org150` | round 1, tracing on, **5%** sampled |
| `2026-08-14-080625-org150` | round 2, tracing **off** |
| `2026-08-14-080806-org150` | round 2, tracing on, **100%** sampled |
| `2026-08-14-080947-org150` | round 2, tracing on, **5%** sampled |

The phase 2 table those six produce is in `plans/2026-08-13_drill-06-request-id-propagation.md`.

### 2026-08-15 — drill 07, the cost of tenant isolation

26 runs in one sitting, four arms, `NAME=` on every one. Table and findings in
`plans/2026-08-15_drill-07-tenant-isolation.md`.

| arm | runs | what it was |
|---|---|---|
| `before` | org1 ×2 (16:06–16:15), org150 ×5 (16:07–16:41) | pre-drill-07 commit `219f91b`, serving as the owner. **Discarded as a comparator** — 33% spread, see below |
| `repo` | org1 ×2 (16:48–16:49), org150 ×3 (16:28–16:43) | the *rejected* repository layer — app-level scoping, no transaction, no pinned client. The zero point the table actually uses |
| `txn-only` | org1 ×2 (16:09–16:18), org150 ×5 (16:10–16:44) | the seam with policies **disabled** — isolates the transaction wrapper from the policies |
| `rls-on` | org1 ×2 (16:12–16:21), org150 ×5 (16:13–16:46) | the shipped mechanism |

**Why `before` is kept but not used.** Its five org150 runs range 2,375 → 3,147 req/s, a 33%
spread against 1.6–5% for the other three arms. It is the only arm requiring a whole-tree
`git checkout`, so it is the only one whose process restarts into a cold JIT and an empty pool.
The runs are kept because that finding is worth more than the arm was: drill 05 said *interleave
arms in one sitting*, and drill 07 adds **arms must differ only in the variable, not in whether
the process restarted**.

**These twelve predate `summary.txt` and have none.** It was not back-filled, because the only
honest way to produce one is to re-run, and a re-run on a different evening is a different number —
that is drill 05's finding 4. Their HTML is still in history at commit `3d61a41`, and the numbers
they support are tabulated in the two plan files above.

## What was removed, and where it went

Drill 06 phase 1's A/B left 21 reports, and they were committed in bulk by a `git add -A` rather
than chosen. None carried a record of which arm it was, so none could be read as evidence; the
numbers they support are all tabulated in
`plans/2026-08-13_drill-06-request-id-propagation.md`. They were removed
from the tree in the 2026-08-14 cleanup and are still in history at commit `8f616c5` if a run ever
needs re-examining:

```bash
git show 8f616c5 --stat -- k6/reports/
git checkout 8f616c5 -- k6/reports/<file>
```

## If you add more

Pass `NAME=` so the arm is in the name, and record it in the table above in the same commit, or do
not commit the summary. Six labelled runs beat thirty unlabelled ones — the mapping is the part
that cannot be reconstructed later.

A smoke test is not a run: `summary.txt` is written however short the run was (k6 skips only the
dashboard, below roughly five seconds), so delete the directory afterwards rather than let a 2s
throwaway into the index.

### 2026-08-17 — drill 08, N+1 (naive vs batched)

| run | what it was |
|---|---|
| `2026-08-17-153701/153959/154256-org1` | naive strategy (1+N per-row lookups), whale, 3 rounds |
| `2026-08-17-153828/154122/154419-org150` | naive strategy, tail, 3 rounds |
| `2026-08-17-154604/155151/155459-org1` | batched strategy (LEFT JOIN + 1 tags query), whale, 3 rounds |
| `2026-08-17-154727/155314/155622-org150` | batched strategy, tail, 3 rounds |
| `2026-08-17-155850-org150` | stretch: batched, `QUERY_COUNTER=off`, tail — prices the counter itself |
| `2026-08-17-160043-org150` | stretch: batched, `pg_stat_statements` preloaded, tail — prices that instrument |

`pg_stat_statements` was **off** (production default) for all 12 primary runs — the two stretch
runs are the only ones with it on. The whale runs landed on a noisy evening: within-arm spread for
org 1 was 14-17% in both arms, comparable to the 20-24% naive-vs-batched delta, so that comparison
is **inside the noise floor** per the 15%/20% rule — the tail (spread 2-4%, delta ~63%/177%) and an
isolated `EXPLAIN (ANALYZE, BUFFERS)` (no concurrency) are the trustworthy numbers for the whale.
Full table and reasoning in `plans/2026-08-17_drill-08-n-plus-one.md`.
