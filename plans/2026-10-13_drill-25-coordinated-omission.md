# Drill 25 — Build a load test that lies, then fix it

**Status:** shipped

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
2. **Whale deep pages are the slow slice.** Org 1 at `page=10000` and deeper: 260–400ms alone. Page
   5,000, twelve at once: 500–840ms, all 200. The page walks 200,000 index entries. Its `count(*)`
   runs two parallel workers on an index-only aggregate, which `/dev/shm` holds at this concurrency.
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

## Revised while shipping

- `pnpm load` from this worktree needs `COMPOSE_PROJECT_NAME=drills`. The worktree's `.env` names
  another project, so the first smoke run put k6 on a fresh network where `nest_server` did not
  resolve.
- `SLOW_PAGE` became `SLOW_PATH` (default `/conversations?page=10000&pageSize=20`). Part D needed the
  whale search as a slow slice, because its `/dev/shm` failures are the fast-failure case.
- At exactly 1% failed, k6 interpolated time-to-success p99 between a real sample and the `NEVER`
  sentinel (it printed 10,000,426ms). Any value above the run's real max now prints `never`.
- Part C used 2 VUs, not 10. At 10 VUs the uniform arm is at capacity, and a stall test has to run
  below it.
- Part D's fast-failure arm used a 4% search slice. At 2%, half the searches failed: exactly 1% of
  requests, so p99 sat on the boundary and moved between runs (40.30, 33.43, 290.62ms).
- B's first open run at X pre-allocated 200 VUs. k6 allocated the rest mid-run and dropped 935
  iterations while it did, which made it partly closed (p50 372ms against 1,931–1,952ms). It is
  reported with E.

## Results

Docker Desktop, 14 CPUs. Dev `nest_server` (pool 10, `QUERY_COUNTER=on`), one sitting. k6 2.1.0 in
the Compose network, 20s warm-up, 60s measured. Fast slice: org 150's list page 1. Slow slice: org 1
at page 10,000. Reports: `k6/reports/2026-10-13-01*` to `-02*`.

### A. Same mean, different p99 (open, 100 req/s)

| Arm | Run | mean | p50 | p95 | p99 | p99 ÷ mean |
|---|---|---|---|---|---|---|
| uniform (org 2, no slow slice) | 1 | 5.26 | 5.09 | 6.60 | 7.65 | 1.5× |
| uniform | 2 | 5.07 | 4.88 | 6.03 | 7.14 | 1.4× |
| mixed (org 150 + 2% whale page 10,000) | 1 | 5.84 | 2.25 | 3.38 | 178.90 | 30.6× |
| mixed | 2 | 5.84 | 2.25 | 3.46 | 177.56 | 30.4× |

Means differ by 11–15%. p99s differ by **23.2–25.1×**. Mixed has the lower p50 and p95: the fast
slice owns them. The slow slice is 2.0% of requests; its own p50 is 177.6–178.9ms. Org 2 was picked
by four 20s calibration runs (orgs 2, 3, 10, 15: means 5.39, 5.07, 5.23, 2.99ms).

### B. Saturation (the mixed workload)

| Model | Offered | Run | Served req/s | mean | p50 | p95 | p99 | Errors | Dropped |
|---|---|---|---|---|---|---|---|---|---|
| closed, 10 VUs | — | 1 | 1,059.30 | 9.35 | 3.98 | 7.09 | 239.74 | 0 | — |
| closed, 10 VUs | — | 2 | 1,012.75 | 9.78 | 4.23 | 7.70 | 249.40 | 0 | — |
| closed, 50 VUs | — | 1 | 1,058.23 | 47.17 | 40.70 | 58.38 | 322.98 | 0 | — |
| closed, 50 VUs | — | 2 | 1,062.38 | 46.98 | 40.39 | 58.90 | 316.91 | 0 | — |
| open | 530 | 1 | 530.02 | 5.86 | 1.95 | 3.35 | 185.98 | 0 | 0 |
| open | 530 | 2 | 530.02 | 5.86 | 1.93 | 3.46 | 184.27 | 0 | 0 |
| open | 850 | 1 | 850.02 | 9.05 | 3.01 | 17.21 | 212.27 | 0 | 0 |
| open | 850 | 2 | 850.02 | 43.04 | 3.38 | 321.50 | 509.43 | 0 | 0 |
| open (X) | 1,060 | 2 | 1,039.72 | 1,871.37 | 1,951.65 | 2,023.11 | 2,399.18 | 2,960 (4.74%) | 1,218 |
| open (X) | 1,060 | 3 | 1,024.98 | 1,865.16 | 1,931.13 | 2,827.49 | 3,501.82 | 2,679 (4.36%) | 2,102 |
| open | 1,400 | 1 | 1,346.58 | 2,040.53 | 2,006.51 | 2,246.41 | 2,967.42 | 35,682 (44.16%) | 3,206 |
| open | 1,400 | 2 | 1,337.00 | 2,064.10 | 2,005.37 | 2,169.26 | 3,864.95 | 31,634 (39.43%) | 3,781 |

- Little's law holds for the closed runs: 10 ÷ 1,059.30 = 9.44ms (measured mean 9.35); 50 ÷ 1,058.23
  = 47.25ms (47.17). Five times the VUs bought the same throughput and five times the latency.
- At its own X (1,060 req/s) the open model's p50 is **456–490×** the closed runs' (1,931–1,952 against
  3.98–4.23ms). In run 2 the p99 per 10s window rose from 1,817 to 2,423ms over five windows. Postgres
  ran at ~980% CPU during run 1.
- At 1,400 offered, served req/s (1,337–1,347) counts failures. Successful requests per second were
  752–810, **below** the closed model's 1,059: the pool spends its time on requests that then fail.
- Capacity sits between 850 and 1,060. At 850 one run held (p95 17ms) and one queued (p95 322ms).

### C. A 2s stall, below saturation (uniform org 2, `docker pause drills_backend` 30s in)

| Model | Run | req/s | mean | p50 | p99 | max | p99 in the stall's window | Requests in that window |
|---|---|---|---|---|---|---|---|---|
| closed, 2 VUs | 1 | 398.58 | 4.97 | 4.61 | 6.45 | 2,053.16 | 6.52 | 3,300 (others ~4,100) |
| closed, 2 VUs | 2 | 387.32 | 5.11 | 4.80 | 6.90 | 2,044.83 | 7.97 | 2,990 |
| open, 400/s | 1 | 400.00 | 60.47 | 4.89 | 1,785.44 | 2,224.66 | 2,158.56 | 4,000 |
| open, 400/s | 2 | 400.02 | 62.46 | 4.96 | 1,827.15 | 2,246.10 | 2,179.06 | 4,000 |

Same server, same stall: the open p99 is **265–277×** the closed one. The closed model recorded the
stall as 2 slow samples (one per VU) and ~800–1,100 requests it never sent.

### D. p99 of what population

| Run | Failures | Failed | Successes only | Every answer | Time to success |
|---|---|---|---|---|---|
| `--req-timeout 150ms`, 1 | timeouts (whale pages) | 120 (2.00%) | 4.21 | 150.47 | never |
| `--req-timeout 150ms`, 2 | timeouts | 121 (2.02%) | 4.03 | 150.58 | never |
| 4% whale search, 400/s, 1 | fast 500s (`/dev/shm`) | 721 (3.00%) | 466.79 | 76.57 | never |
| 4% whale search, 400/s, 2 | fast 500s | 721 (3.00%) | 466.30 | 62.30 | never |
| B open at 1,400, 1 | 2s pool acquire | 35,682 (44.16%) + 3,206 dropped | 2,968.07 | 2,967.42 | never |

- Slow failures: dropping them cut p99 from 150ms to 4ms (**36–37×**) and removed every whale request.
- Fast failures: dropping them raised p99 from 62–77ms to 466ms (**6.1–7.5×**). Counting them in
  made p99 look better.
- At 2s acquire failures, both views agree on p99 and both hide that 46% of offered requests never
  got an answer.
- Postgres logged 325 `could not resize shared memory segment` lines across one 4%-search run's
  warm-up and measured windows.

### E. k6 omits too

| Run (open, 1,060/s) | Max VUs | p50 | p99 | Errors | Dropped |
|---|---|---|---|---|---|
| E | 20 | 5.20 | 259.65 | 0 | 2,354 (3.70%) |
| B run 1 | 3,000, 200 pre-allocated | 372.51 | 800.81 | 0 | 935 |
| B runs 2–3 | 3,000, 1,500 pre-allocated | 1,931–1,952 | 2,399–3,502 | 4.4–4.7% | 1,218–2,102 |

Capped at 20 VUs, k6's "open" run reported the closed model's picture: p50 5.20ms, 0 errors. Only
the dropped count shows what happened.

### Stretch: three earlier headlines under the open model

Each card's arm was set by recreating `nest_server` with `--no-deps`; defaults were restored after.

**Drill 22, `pnpm load pool --org 2-10`, `QUERY_COUNTER=header`. The headline changes.**

| Pool | Load | p50 | p95 | p99 | Pool wait (mean) | Errors | Served |
|---|---|---|---|---|---|---|---|
| 10 | closed, 100 VUs | 524.72 | 736.15 | 764.99 | 511.23 | 0 | 176.45 |
| 10 | open 100/s | 5.82 | 46.36 | 53.03 | 0.01 | 0 | 100.02 |
| 10 | open 150/s | 6.93 | 183.95 | 188.29 | 0.02 | 0 | 150.00 |
| 10 | open 250/s | 2,001.48 | 2,221.49 | 2,628.13 | 2,011.90 | 6,655 (45.55%) + 390 dropped | 243.52 (132.6 good) |
| 32 | closed, 100 VUs | 224.79 | 604.46 | 633.49 | 207.24 | 0 | 327.48 |
| 32 | open 100/s | 5.83 | 45.79 | 52.84 | 0.01 | 0 | 100.02 |
| 32 | open 150/s | 7.03 | 184.93 | 192.25 | 0.02 | 0 | 150.02 |
| 32 | open 250/s | 6.77 | 287.41 | 296.76 | 0.02 | 0 | 250.02 |

Drill 22 said pool 10 made each request wait ~500ms for a connection. That wait is the 100 closed
VUs: below 150 req/s, pools 10 and 32 are indistinguishable and wait 0.01–0.02ms. "Ship 32" survives
for a different reason: pool 10 collapses between 150 and 250 req/s, and pool 32 holds 250. The
p99-against-pool-size curve was Little's law applied to 100 VUs, not a property of the pool.

**Drill 08, `pnpm load list --org 150`, `LIST_STRATEGY`. Holds; the size depends on the load.**

| Arm | Load | p50 | p95 | p99 | Served |
|---|---|---|---|---|---|
| naive | closed, 10 VUs | 13.90 | 16.71 | 19.38 | 707.15 |
| naive | open 400/s | 7.85 | 9.43 | 11.83 | 400.02 |
| naive | open 650/s | 23.89 | 344.97 | 363.92 | 649.35 (40 dropped) |
| batched | closed, 10 VUs | 5.17 | 7.01 | 8.79 | 1,885.23 |
| batched | open 400/s | 1.45 | 2.11 | 2.74 | 400.02 |
| batched | open 650/s | 1.51 | 2.12 | 2.88 | 650.02 |

Closed: p95 −58%, throughput 2.67× (drill 08 measured −63.5% and 2.77×). Open: p95 −78% at 400/s
and −99.4% at 650/s. A p95 delta from a closed run is not a number that transfers to any load.

**Drill 05, `pnpm load list`. Holds.**

| Org | Load | p50 | p95 | p99 | Served |
|---|---|---|---|---|---|
| 1 (whale) | closed, 10 VUs | 34.99 | 44.65 | 49.77 | 283.30 |
| 1 | open 140/s | 17.48 | 18.88 | 19.71 | 140.02 |
| 1 | open 255/s | 25.78 | 38.63 | 44.11 | 255.02 |
| 1 | open 400/s | 2,030.85 | 2,268.05 | 2,610.55 | 386.45; 6,595 errors (28.44%), 814 dropped |
| 150 (tail) | open 140/s | 2.21 | 2.92 | 3.59 | 140.02 |
| 150 | open 255/s | 1.71 | 2.25 | 2.65 | 255.02 |

At the same offered rate the whale's p99 is 5.5× (140/s) to 16.6× (255/s) the tail's. The closed
whale p99 (49.77ms) is the p99 at 10 requests in flight: at half that throughput the open p99 is
19.71ms. The 91× gap drill 05 recorded came from the missing index (drill 09), not the model.

### Predictions, scored

| # | Prediction | Measured | Score |
|---|---|---|---|
| 1 | means ±25%, p99 ≥ 10×, mixed p50/p95 lower | means +11–15%, p99 23.2–25.1×, p50 2.25 vs 4.88–5.09 | hit |
| 2 | closed 10 VUs: 0 errors, fast p99 near unloaded | 0 errors; fast-slice p99 8.79–9.75ms (4.03–4.08 unloaded) | hit, fast p99 doubled from Node's queue |
| 3 | open at X: p50 ≥ 10×, errors or drops | p50 456–490×, 4.4–4.7% errors, 1,218–2,102 dropped | hit |
| 4 | stall: closed p99 < 2× move, open ≥ 1s | closed 6.45–6.90ms, open 1,785–1,827ms | hit |
| 5 | dropping timeouts flatters p99 | 150ms → 4ms; time to success `never` | hit; the fast-failure direction was not predicted |
| 6 | too few VUs: drops and better-looking percentiles | 20 VUs: p50 5.20ms, 2,354 dropped | hit |

## Write-up

**Coordinated omission in one sentence.** A load generator that waits for each response before
sending the next one slows down exactly when the server does, so it never sends the requests that
would have queued, and its percentiles describe a server that was never under the load you think.

**Which executor made the open model, and what does it show that the closed one doesn't?**
`constant-arrival-rate` (`--model open --rate R`), with `maxVUs` high enough that k6 never has to
drop. It shows three things the closed model cannot:
- the queue: latency that grows window by window when offered load meets capacity (1,817 → 2,423ms);
- failures that only exist under a queue: 2s pool-acquire 500s, 4.4% at X and 39–44% at 1,400/s;
- `dropped_iterations`, the requests the generator itself could not send.
The closed model at the same throughput reported p50 3.98ms, p99 240ms and 0 errors. Its latency
was VUs ÷ throughput: 10 VUs gave 9.4ms, 50 VUs gave 47ms, at the same 1,059 req/s. A 2s stall cost
the closed run two slow samples; it cost the open run p99 1.8s.

**What's the honest way to report p99 when 2% of requests never returned?** Count every offered
request, and count one that never returned as slower than anything measured. With 2% missing, p99
lies inside the missing 2%, so the honest p99 is "more than the timeout". Write it as `> 150ms
(2.0% never answered)`, never as the 4ms the successes alone give. Better still, report the share
of offered requests that succeeded within the target (98.0% within 150ms) and the failure rate
beside it. Two rules make it honest:
- The denominator is offered requests: sent + failed + timed out + dropped by the generator.
- A latency number is never printed without its success rate.
Dropping errors moves p99 either way: down 36–37× when failures are timeouts, up 6–7.5× when they are
fast 500s. Either way, it describes a population nobody asked about.
