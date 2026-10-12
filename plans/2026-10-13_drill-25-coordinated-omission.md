# Drill 25 — Build a load test that lies, then fix it

**Status:** in progress

Card 25. Prereq 24. Branch `drill-25` (from `main` at `41b2c25`). Saved as
`plans/2026-10-13_drill-25-coordinated-omission.md`.

## Context

Every k6 number in this repo since drill 05 comes from a closed model: N VUs, each sending its next
request only after the last one returned. When the server slows down, a closed model sends less. The
card asks for three things:

1. A workload whose mean looks fine and whose p99 does not: fast traffic with a small slow slice of
   whale queries. Report both.
2. The same target under fixed VUs and under a constant arrival rate, compared once the server is
   saturated.
3. p99 of what population: what the number does when failed and timed-out requests are dropped.

Facts from probing the running stack (dev `nest_server`, pool 10, warm caches):

1. **Fast and medium reads.** `GET /conversations?page=1&pageSize=20`: org 150 (tail) 3.4–4.1ms,
   orgs 2–10 7–9ms, org 1 (whale) 25–37ms. Drill 05's whale p50 of 175ms is gone: drill 09's index
   serves it now.
2. **Whale deep pages are the slow slice.** Org 1 at `page=10000` and deeper: 260–300ms alone. Twelve
   at once: 500–840ms, all 200. No parallel workers.
3. **Whale search cannot be the slow slice.** `q=export` on org 1 takes 1.5–3.8s (a Parallel Bitmap
   Heap Scan reading 146k blocks). Three concurrent searches all fail in ~80ms with `could not
   resize shared memory segment` (64MB `/dev/shm`); two succeed. Its failures would be fast 500s, not
   latency. Issue 36 names only the stats aggregate; search has the same ceiling at concurrency 3.
4. **The harness is closed by default.** `scenario()`'s default shape is `constant-vus`. Only
   `drain.ts` and `conversations-write.ts` declare `constant-arrival-rate`. `list`, `search` and
   `pool` cannot run open without editing the script. `summary()` already prints
   `dropped_iterations` for an arrival-rate run.
5. **k6's open model drops; it never delays.** `constant-arrival-rate` starts each iteration on
   schedule if a VU is free and drops it if none is. Latency is measured from the actual send. So
   k6 is open only while `maxVUs` ≥ rate × latency; past that, the omitted requests are the
   `dropped_iterations` count.
6. **Server-side overload has a 2s edge.** The pool fails a queued acquire after its 2s connect
   timeout, so overload surfaces as 500s at ~2s.

## Decisions

1. **`MODEL=closed|open` in `k6/lib/scenario.ts`** (default `closed`). `open` makes the default
   shape `constant-arrival-rate` at `RATE`/s with `preAllocatedVUs: VUS` and `maxVUs: MAX_VUS`
   (default 1000). Every script on the default shape (`list`, `search`, `pool`, the new `mix`) gains
   `--model open`. An unknown value throws. `closed` keeps every recorded run's shape.
2. **`k6/latency-mix.ts`, run as `pnpm load mix`.**
   - Fast: `--org`'s list at `--page`. Commands pass `--org 150`.
   - Slow: every `SLOW_EVERY`-th iteration (default 50, 2%) is `SLOW_ORG`'s (1) list at
     `SLOW_PAGE` (10000). The pick is by `exec.scenario.iterationInTest`, so the slow share is the
     same under both models. `--slow-every 0` turns the slice off (the uniform arm).
   - `REQ_TIMEOUT` (default `60s`, k6's own) is the client's patience.
   - Tags: `ep:fast|slow` and `w:<10s window of the measured stage>`.
3. **Three populations, all from k6's own aggregates.** No raw sample dump.
   - *Successes only*: `http_req_duration{scenario:measure,expected_response:true}`. Most
     dashboards plot this one.
   - *Every answer*: `http_req_duration{scenario:measure}`. A failure counts at its elapsed time, a
     timeout at the timeout.
   - *Time to success*: a custom Trend where a failure is recorded as `NEVER` (1e9 ms) and printed
     as `never`. Its p99 is `never` once more than 1% failed.
   - Dropped iterations are printed beside them as never sent:
     `never answered = (failed + dropped) / (measured + dropped)`.
4. **The summary adds** the slices (share, p50, p99), mean against p99, p99 per population, the
   never-answered share, and p99 and request count per 10s window. The window row shows a queue
   growing, which a whole-run percentile averages away.
5. **Report directory:** `rate<R>` replaces `vus<N>` when `--model open`. This fixes issue 35 for the
   new path; recorded directory names do not change.
6. **No backend change.** The stall is `docker pause drills_backend` for 2s, from the shell.

## Predictions, recorded before any run

1. **Same mean, different p99.** Open at 100 req/s: mixed (org 150 + 2% whale page 10000) against
   uniform (one mid org, chosen so the means match). Means within ±25%. Mixed p99 ≥ 10× uniform's.
   Mixed p50 and p95 are *lower* than uniform's: the fast slice owns them.
2. **The closed model at saturation looks healthy.** Mixed, 10 VUs: 0 errors and no pool wait,
   because 10 VUs never exceed a pool of 10. Fast-slice p99 stays near its unloaded value.
   Throughput X is the server's pace, not an offered load.
3. **The open model at X does not hold.** Mixed, open at the closed run's own X: fast requests queue
   for the pool behind whale pages. p50 rises ≥ 10×; errors (2s acquire) or drops appear.
4. **A stall hides from the closed model.** Uniform, 2s `docker pause` 30s into the measured
   window. Closed 10 VUs records ≤ 10 slow samples, so its p99 moves < 2×. Open at the same rate
   records ~rate × 2s delayed samples, so its p99 ≥ 1s.
5. **Excluding failures flatters p99.** With a timeout below the whale latency, ~2% fail. p99 over
   successes ≈ the fast slice's p99: the whales vanish. p99 over every answer ≈ the timeout. Time to
   success: `never`.
6. **k6 omits too.** An open run whose `maxVUs` is too small reports drops, and its latency
   percentiles look better than a run with enough VUs at the same rate.

## What ships

**Edits**
- `k6/lib/scenario.ts`: `MODEL`, `MAX_VUS`, the open branch in the default shape.
- `scripts/load.ts`: `--model` and `--max-vus` in `COMMON`; the `mix` entry; `rate<R>` in the
  directory name for open runs.

**New**
- `k6/latency-mix.ts`.

`pnpm check:arms` covers the new knobs: every `__ENV` read must be forwarded by `scripts/load.ts`
with the same default.

## Measurement

One sitting, dev stack, server defaults. `VACUUM (ANALYZE) conversations` first. 20s warm-up, 60s
measured. Arms interleaved, two runs each.

- **A. Mean against p99.** Open at 100 req/s: `mix --org 150` and `mix --org <mid> --slow-every 0`.
  One calibration run picks `<mid>` from orgs 2–10.
- **B. Saturation.** `mix --org 150`: closed 10 VUs (throughput X), open at X, open at X/2.
- **C. A stall.** `mix --org <mid> --slow-every 0`: closed 10 VUs, then open at its throughput, each
  with a 2s pause of `drills_backend` 30s into the measured window.
- **D. Populations.** `mix --org 150 --model open --rate 100 --req-timeout <t>`, with `<t>` below the
  slow slice's p10 from A. Also B's saturated open run, read three ways.
- **E. k6's own omission.** B's open run at X with `--max-vus` too small.

## Stretch (if the core lands cleanly)

Re-run the headline of three earlier cards under the open model, closed beside it in the same
sitting: drill 05 (whale against tail list), drill 08 (`LIST_STRATEGY=naive|batched`) and drill 22
(pool 10 against 32 on `pool-mix`). If a conclusion changes, the card's guide says so at the top.

## Write-up and guide

The Results and Write-up sections answer the card:
1. Coordinated omission in one sentence.
2. Which executor made the open model, and what its output shows that the closed one does not.
3. The honest way to report p99 when 2% of requests never returned.

`drills/25-coordinated-omission.md` (gitignored) is drafted in the worktree and copied to the main
checkout. It contains ELI5, a closed-against-open diagram, charts of the results, every command with
its result, a tech stack cheat sheet, `Is this production ready?`, `Honest gaps` and `What I'd do
differently at 10x`.

## Workflow

1. Write this plan and the `planned` history row; commit both before any code.
2. Commit the harness change and the script.
3. Measure; record results in this plan.
4. Guide; README row.
5. `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:arms`.
6. Memory bank update; history row → `implemented`.
7. PR, then the `drill/25` release (0.25.0), tagged on the branch before the merge.

## Verification

- `pnpm load mix --org 150 --model open --rate 100` prints `rate=100.00/s`, a `dropped` line, and a
  report directory with `rate100`.
- `pnpm load list` prints exactly the closed-model block it printed before.
- `pnpm check:arms` passes; renaming `MODEL` in either file fails it.
- Every number in Results has its command beside it.
