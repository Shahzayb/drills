# Drill 05 — Record the baseline: p50 / p95 / p99 and throughput on the loaded database

**Status:** shipped

## Context

Drill 04 put 2.5M conversations and 10M messages on disk. Drill 03's endpoint is naive on
purpose and cards 08/09/10 are going to make it fast. In eight weeks the claim will be "the
inbox got 4x faster" — and that claim is worth nothing without a number taken _before_, with a
method that can be re-run unchanged.

Everything measured so far has been measured wrong for this purpose. Drill 03's table is 12
requests against 64 rows. Drill 04's numbers are `EXPLAIN` timings — the database's view of
itself, not the client's, and they exclude the pool, the framework, the JSON serialisation and
every queue between the socket and the planner. Neither has a p99, neither has a throughput, and
neither survives being re-run by a different person on a different evening.

This drill produces one thing: **a six-run table with a stated noise floor**, plus the honesty
notes that say what was left out of it.

### What already existed before this plan

Working and kept as-is:

- `docker-compose.yml` — a `k6` service on `app-network` under `profiles: ["test"]`, with
  `entrypoint: ["k6"]` and `./k6:/scripts` bind-mounted. Being on the Compose network is what
  lets the script address `http://nest_server:3002` by service name.
- `.mcp.json` — the k6 MCP server, for docs and script validation.
- `@types/k6` in root devDependencies.
- `k6/test.js` — 10 VUs, 60s, `GET /conversations?page=1&pageSize=20`, `x-org-id: 1`.

`k6/test.js` was missing everything the card grades: no p99 (k6's default summary stops at p95),
no warm-up exclusion, no throughput figure that means anything, no org parameter, and no record
written anywhere. It became `k6/conversations-baseline.js` rather than surviving alongside it.

## Decisions

**Warm-up is excluded with two scenarios in one script, not two invocations.** A `warmup`
scenario runs 20s, then a `measure` scenario runs 60s starting at `startTime: '20s'`. k6 tags
every metric with the built-in `scenario` system tag, and a threshold on
`http_req_duration{scenario:measure}` is what makes that sub-metric appear in the summary at
all. One command, one summary, nothing to remember — which is the whole point of "re-run
unchanged".

**`gracefulStop: '0s'` on warmup**, so the two scenarios never overlap and k6 allocates 10 VUs
rather than 20. At most 10 in-flight warm-up requests get cut off; they carry `scenario:warmup`
and are excluded from every reported number anyway.

**The image is pinned to `grafana/k6:2.1.0`, not `:latest`.** A baseline re-run in eight weeks
against a different k6 is not the same measurement, and `:latest` changes the instrument
silently. Same class of mistake as `POSTGRES_INITDB_ARGS` in drill 04 — a config that looks
stable and isn't.

**No think time.** 10 VUs with no `sleep()` is a closed-loop saturation test: each VU sends the
next request the instant the last one returns. It measures how fast the system goes when pushed,
and queueing delay shows up in p99. The alternative (fixed arrival rate with think time) measures
something different and arguably better, and belongs to a later card — noted in the guide, not
built here.

**Dev watch mode, not the prod build.** `nest start --watch` already runs compiled JS and the
watcher is idle during a run, so the distortion is small — and every later drill will be measured
the same way, which is what a before/after comparison actually requires. Recorded as a caveat
rather than hidden.

**`VACUUM (ANALYZE) conversations` before the sweep.** Drill 04 established that `count(*)` on
this table is a 60ms seq scan un-vacuumed and a 27ms index-only scan after — a 2x swing from a
background process getting round to it. Leaving that to chance would put a factor of two inside
the noise floor. It is run explicitly before the sweep, so the database's state is part of the
stated method rather than an accident of when you ran it.

**The stretch threshold is env-gated and off by default.** A failing threshold exits 99 and would
break the sweep mid-run. `P95_BUDGET_MS` sets it when card 31 wants it; unset, the threshold is
not registered and the baseline runs are unaffected.

## Files

- `k6/conversations-baseline.js` — the script. Parameterised by `ORG_ID`, `VUS`, `WARMUP`,
  `DURATION`, `P95_BUDGET_MS`. It prints and writes nothing.
- `k6/reports/<yyyy-mm-dd-hhmmss>-<script>-org<id>-vus<n>-<duration>.html` — k6's own web
  dashboard, self-contained. The only artifact a run leaves. The local timestamp leads (finding 4
  makes the sitting part of what produced the numbers, and it sorts the directory into sweeps) and
  is what makes the name unique — a re-run under the hand-chosen `RUN` label this used to carry
  overwrote a recorded run already. The rest carries every knob that changes the measurement. Note
  k6 skips the export entirely on a run of a few seconds ("report generation was skipped, not
  enough data"), so a smoke test leaves no file.
- `docker-compose.yml` — image pinned. Untouched otherwise: the `k6` service stays a plain
  runner, and a run's parameters travel on the command line where the run can be read off it.
- `k6/run-baseline.mjs` — one run: makes `k6/reports/` (k6 will not create it), then `docker
  compose --profile test run` with the knobs forwarded and the dashboard named. `package.json`'s
  `load:baseline` is `node k6/run-baseline.mjs` and nothing else.

Three details in the script are decisions, not style:

1. **`summaryTrendStats` is what makes p99 exist.** k6's default summary stops at p(95). Without
   this line the card's central deliverable is simply not printed.
2. **Two thresholds exist only to create sub-metrics** (`max>=0` on the duration, `count>0` on
   `http_reqs`). They can never fail. In k6, a tagged sub-metric is not computed unless a
   threshold names it — the threshold is the declaration, and using it as one looks like dead
   code unless you know that.
3. **Throughput is `count / measureSeconds`, never `values.rate`.** k6 divides its own rate by
   the whole run duration, warm-up included, which understates the measured phase by ~25%. This
   is the one arithmetic trap in the script.

## Method

Orgs confirmed against the loaded database, not assumed:

| Role  | org_id | conversations |
| ----- | ------ | ------------- |
| whale | 1      | 1,000,000     |
| tail  | 150    | 2,631         |

org 150 rather than any other tail org because drill 04's `EXPLAIN` comparison used it, so the
query plans in that plan file line up with the latencies in this one.

Six runs in a fixed, recorded order — whale 1/2/3 then tail 1/2/3. Each run is 20s warm-up + 60s
measured. Order is part of what produced the numbers, so it gets written down.

**One extra run, recorded separately: 20 VUs against the whale.** Not part of the six. It answers
the question that invalidates every load test and that nobody asks — _was the load generator the
bottleneck?_ If doubling VUs roughly doubles latency and leaves throughput flat, the server was
saturated and the six runs measure the server. If throughput climbs instead, k6 was the limit and
the whole table is about k6.

**Noise floor** is reported per metric as `(max − min) / median × 100` across the three runs,
separately for p50, p95, p99 and throughput — not as one number. p99 is expected to be much
noisier than p50, and that difference is itself the finding: it sets a different "too small to
believe" bar for tail latency than for typical latency.

## Results

The card's writeup answers are in `drills/05-writeup-worksheet.md`. This is the record: all six
runs, because the card asks for every one rather than an average. 10 VUs throughout, 20s warm-up
excluded, 60s measured.

| org | run | p50 | p95 | p99 | throughput | requests |
|---|---|---|---|---|---|---|
| whale (1) | 1 | 179.84 ms | 343.01 ms | 370.63 ms | 47.75 req/s | 2,865 |
| whale (1) | 2 | 175.54 ms | 340.27 ms | 379.53 ms | 48.57 req/s | 2,914 |
| whale (1) | 3 | 175.05 ms | 335.77 ms | 375.36 ms | 48.97 req/s | 2,938 |
| tail (150) | 1 | 2.18 ms | 3.10 ms | 4.38 ms | 4,298.13 req/s | 257,888 |
| tail (150) | 2 | 2.14 ms | 2.89 ms | 4.09 ms | 4,437.52 req/s | 266,251 |
| tail (150) | 3 | 2.14 ms | 2.93 ms | 4.11 ms | 4,414.63 req/s | 264,878 |

Medians of the three, which is the column cards 08/09/10 get compared against:

| | p50 | p95 | p99 | throughput |
|---|---|---|---|---|
| whale (org 1, 1,000,000) | 175.54 ms | 340.27 ms | 375.36 ms | 48.57 req/s |
| tail (org 150, 2,631) | 2.14 ms | 2.93 ms | 4.11 ms | 4,414.63 req/s |
| **ratio** | **82.0x** | **116.1x** | **91.3x** | **90.9x** |

Zero failed requests across all six runs. **Within-sweep noise floor 1.9%–7.2%**, worst cell
tail p95 — but see finding 4: that is not the number to plan against.

### What the drill actually taught, beyond the table

1. **Drill 03's prediction #2 was wrong, and #1 was right.** `count(*)` is _not_ the whale's
   bottleneck — post-`VACUUM` it is a 33.0ms index-only scan. The list query is 102.4ms, a
   parallel seq scan plus top-N heapsort, because there is no `(org_id, updated_at DESC, id DESC)`
   index. The `Sort` was the first casualty exactly as predicted; the `count(*)` warning was the
   red herring. Card 09, not card 08, is where the whale's time goes.

2. **The pool is oversubscribed 2:1 and nobody noticed until now.** `Promise.all` of two queries,
   each taking its own connection from `pool.query()`, means 2 connections per in-flight request —
   20 wanted from `max: 10` at 10 VUs. Unloaded database time is ~102ms; loaded p50 is 176ms.
   Recorded as **inference**: `PostgresService.stats()` exists but is not on a route, so nothing
   observed the pool directly. Wiring that up is the cheapest observability win available.

3. **The load generator was not the bottleneck, and it was checked.** 20 VUs against the whale:
   latency 2.3x worse (396ms p50), throughput slightly _down_ (47.27 vs 48.57 req/s). Saturation,
   so the six runs measure the server. Without this check the whole table would have been an
   unfalsifiable claim.

4. **The noise floor is itself unstable, and the machine drifts monotonically.** The sweep was
   run three times in one evening. Within-sweep floors ranged 0.5%–10.2%, but the *medians*
   moved up to 14% (tail p95) and 6.3% (whale p99) across sweeps — so within-sitting noise
   understates across-sitting noise by ~2x. Worse, the drift has a direction: whale p95 went
   323 → 333 → 340ms and throughput 50.6 → 49.3 → 48.6 req/s, the laptop getting ~4% slower over
   ninety minutes. **A before/after taken hours apart manufactures a 4% delta from thermals
   alone.** Rules adopted: refuse anything under ~15% (20% for the tail), and **interleave A/B
   runs in one sitting** rather than trusting a comparison across sittings.

5. **"p99 is the noisiest percentile" did not hold** — p95 was noisier than p99 on the tail, and
   the whale's four metrics all landed within half a point of each other. p99 sits at the flat
   top of a saturated closed-loop distribution; p95 sits on the steep part. Worth not assuming
   which percentile is stable.

6. **The exclusion argued hardest for turned out to be the smallest.** Warm-up moves the whale's
   p99 by under 1% (364.81 → 368.07). It stays in — being able to say it is under 1% is the
   point, and the cost of finding out was one printed line — but the honest ranking of
   distortions puts the missing network first by a wide margin.

### Process note, recorded because it is the drill's own subject

The first sweep's whale run-1 JSON was overwritten by a later ad-hoc threshold test that
defaulted to the same `RUN=1`/`VUS=10` filename. Rather than keep a file labelled as a 60s
baseline run containing 10s of data, the whole sweep was re-run and `DURATION` was added to the
report filename so the collision is now structurally impossible. The numbers above are the
second, clean sweep. This is why the earlier floors are quoted but not committed.

### Revised after shipping (2026-08-13)

`k6/run-baseline.mjs` was removed, and `pnpm load:baseline:all` with it. The sweep is now driven
by hand from the Method section above instead of by a script. Three things that script was
carrying, so the next person re-checks them rather than rediscovering them:

- **The `VACUUM (ANALYZE)` and the 10s settle are no longer automatic.** Skip them and the
  whale's `count(*)` alone swings by 2x — a factor of two sitting inside a stated noise floor of
  ~2%.
- **Run order and count are no longer enforced**, only written down. The order is part of what
  produced the numbers.

`RUN_DIR` went with it; the `mkdir -p k6/reports` that k6 needs (it fails the output at the *end*
of a run when the path is missing, so a forgotten directory costs the whole run rather than its
first second) is now the first thing `pnpm load:baseline` does.

The shell one-liner that replaced it later moved into `k6/run-baseline.mjs` — same name, but a
single-run wrapper, not the sweep driver: no `VACUUM`, no settle, no fixed order, one `docker
compose run` and the child's exit code passed through (k6 exits 99 on a failed threshold). It
takes the script to run as its first argument (`conversations-baseline.js` by default) and passes
trailing arguments to `k6 run`, so it is a runner for this directory rather than for one file.

It also restored the `vus`/`duration` part of the report filename, which the one-liner had
dropped — that omission put the collision described in the process note back on the table — and
then made the timestamp the unique part instead of `RUN`, which closes that hole rather than
narrowing it: a name can now only collide with a run from the same second.

The generated artifacts went with it — the six per-run directories (`summary.json`,
`console.log`) and then `baseline.csv`. What survives is the HTML dashboard, and only that.
**The Results table above is the record**, which is the point: a number that matters is written
into the plan that explains it, not left in a generated file that the next `--force` deletes.
What a re-run produces is disposable; what it proved is not.

The dashboard is the exception because it is the one output that is *not* reproducible from the
table — percentiles are a single point in time, and only the time series distinguishes a run that
was uniformly slow from one that stalled for five seconds in the middle.

`RUN` itself went too, from both `conversations-baseline.js` and `run-baseline.mjs`. Once the
report filename was made unique by timestamp rather than by `RUN` (above), the only thing `RUN`
still did was label the console report and the `RESULT` CSV row — and the run number a human
reading the terminal wants is either obvious from context (which of the six manual runs you're
currently on) or recoverable from the report's own timestamp. A parameter that only decorates
output nobody parses by machine any more is a parameter to remove, not to keep defaulted to `'1'`
forever. `ORG_ID=150 RUN=3 pnpm load:baseline` is now just `ORG_ID=150 pnpm load:baseline`.

## Risks

- **Nothing is interesting at 10 VUs.** Possible; the tail org may come back flat at 3ms. Still a
  valid baseline — the whale is where the number lives.
- **The `count(*)` dominates the whale so completely that paging cost is invisible.** Likely, and
  it is card 08's problem. The endpoint is not touched in this drill.
- **Laptop contention.** k6, Nest, Next and Postgres share one machine's CPU. This inflates the
  noise floor, which is precisely why the noise floor is reported instead of assumed away.
