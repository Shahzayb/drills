# k6 reports

k6's own web dashboard, one self-contained HTML per run. Worth keeping because it is the run as a
**time series** — the end-of-test summary is a single point in time and cannot tell a uniformly
slow run from one that stalled for five seconds.

The filename records `org`, `vus` and `duration`, and — since 2026-08-14 — an optional arm label
from `NAME=<label> pnpm load:baseline`, which lands right after the timestamp. A label is a hint,
not the record: it is empty by default, and it cannot say what `tracing-off` meant three weeks
later. A report nobody can map back to a condition is not evidence. So: keep the runs a writeup
actually cites, and index them here.

## What is here

| report | what it was |
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

Pass `NAME=` so the arm is in the filename, and record it in the table above in the same commit, or
do not commit the file. Six labelled runs beat thirty unlabelled ones — the mapping is the part that
cannot be reconstructed later.
