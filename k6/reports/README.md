# k6 reports

k6's own web dashboard, one self-contained HTML per run. Worth keeping because it is the run as a
**time series** — the end-of-test summary is a single point in time and cannot tell a uniformly
slow run from one that stalled for five seconds.

The filename records `org`, `vus` and `duration` but **not which arm of an A/B the run was**, which
is the whole problem with keeping a lot of them. A report nobody can map back to a condition is not
evidence. So: keep the runs a writeup actually cites, and index them here.

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

The phase 2 table those six produce is `drills/06-writeup-worksheet.md` §9.

## What was removed, and where it went

Drill 06 phase 1's A/B left 21 reports, and they were committed in bulk by a `git add -A` rather
than chosen. None carried a record of which arm it was, so none could be read as evidence; the
numbers they support are all tabulated in `drills/06-writeup-worksheet.md` §5. They were removed
from the tree in the 2026-08-14 cleanup and are still in history at commit `8f616c5` if a run ever
needs re-examining:

```bash
git show 8f616c5 --stat -- k6/reports/
git checkout 8f616c5 -- k6/reports/<file>
```

## If you add more

Record the arm here in the same commit, or do not commit the file. Six labelled runs beat thirty
unlabelled ones — the mapping is the part that cannot be reconstructed later.
