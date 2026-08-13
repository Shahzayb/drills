# Progress

Where things stand and what's next.

## Current focus

Drill 06 — one request id through Next, Nest, Postgres and Redis. Shipped:

- `x-request-id` generated or accepted at the Next edge, carried into Nest via header, into every
  log line via `AsyncLocalStorage`, into the SQL as `/* rid=… */`, and echoed on the response.
  Both apps log structured JSON through pino. `pnpm logs:trace <id>` reconstructs one request:
  **12 lines, 3 services, one grep.** 27 e2e tests pass across 4 suites.
- **Drill 05's finding #2 is now an observation, not an inference** — the two `Promise.all`
  queries of one request are executed by two different Postgres backend PIDs.
- **Overhead is a fixed ~0.9ms/request, not a percentage.** Tail org (2ms requests): −26.7%
  throughput with logging *silent*, −30.7% `info`, −34.7% `debug`. Whale org (176ms requests):
  **no measurable effect** — "before" landed between two "after" runs. The whale runs also
  reproduce drill 05's baseline (48.02 vs 48.57 req/s).
- The plumbing costs ~4x what the logging does. **A suppressed log line still evaluates its
  arguments** — guarding with `isLevelEnabled` recovered 6.0% at silent, 5.0% at info, and (as
  predicted) nothing at debug.
- See `plans/2026-08-13_drill-06-request-id-propagation.md`,
  `drills/06-request-tracing-and-structured-logs.md` and `drills/06-writeup-worksheet.md`.
- **Not done:** the OpenTelemetry stretch. Scoped as phase 2 in the same plan file.

Drill 05 — the load-test baseline. Shipped:

- `GET /conversations?page=1&pageSize=20` measured with k6, 10 VUs, 20s warm-up excluded,
  60s measured, 3 runs per org. All six runs are tabulated in the plan file, not averaged away.
- Whale (org 1): **p50 175.5ms · p95 340.3ms · p99 375.4ms · 48.6 req/s**.
  Tail (org 150): **p50 2.14ms · p95 2.93ms · p99 4.11ms · 4,415 req/s**. 82–116x apart.
- **Within-sweep noise floor 1.9–7.2%**, but the sweep ran 3x in one evening and the medians
  moved up to 14% — monotonically, the laptop drifting ~4% slower over 90 minutes. Working
  rules: refuse anything under ~15% (20% on the tail), and interleave A/B in one sitting
  rather than trusting a comparison across sittings.
- The whale's cost is the **missing `(org_id, updated_at DESC, id DESC)` index**, not
  `count(*)` — which is a 33ms index-only scan post-vacuum against the list query's 102ms.
  Drill 03's prediction #1 confirmed, #2 refuted.
- Verified the load generator wasn't the bottleneck before believing any of it.
- See `plans/2026-08-13_drill-05-load-test-baseline.md` and `drills/05-writeup-worksheet.md`.

Drill 04 — the bulk seed. Shipped:

- 2.5M conversations and 10M messages seeded in **108s**; `db:reset` from empty in **1:52**.
- Skew is exact: one org holds 1,000,000 conversations, nine hold ~111k each, 190 share the rest.
- Deterministic — two runs produce identical per-table hashes.
- Bodies come from a support-ticket template corpus with faker-filled slots, not lorem ipsum.
- Revised after shipping: the seeder's hand-optimised hot paths were measured against their
  plain equivalents and the three that bought nothing were deleted. Data unchanged except
  `messages`; timing unchanged within noise.
- Simplified again (2026-08-12): the *other* three hot paths went too, plus the 5-flag lever
  matrix and the triplicated structure COPYs. Non-comment code 554 → 472 lines, all five table
  hashes unchanged, 108.21s vs 108.2s. The four SQL levers stay — they buy the time and they
  are what the drill teaches. See `plans/2026-08-12_seed-simplification.md`.

## Next step

Card 07 is the next card in order. Card 09 (the composite index) is where the whale's 176ms
actually lives — drill 05 measured that, against expectation — and card 08 (`count(*)`, keyset
paging) is real but smaller at page 1.

Drill 05's suggested "cheapest win" is now closed: the pool oversubscription was confirmed in
drill 06 by two backend PIDs on one request. (`PostgresService.stats()` was already on a route —
`/info` renders it; that line was stale.) What is still unmeasured is the pool under *load*, since
nothing samples `stats()` during a k6 run.

## Active plan

`plans/2026-08-13_drill-06-request-id-propagation.md` (phase 1 shipped, phase 2 not started),
`plans/2026-08-13_drill-05-load-test-baseline.md` (shipped),
`plans/2026-08-11_drill-04-bulk-seed.md` (shipped),
`plans/2026-08-12_seed-simplification.md` (shipped)

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
`pnpm db:test` runs the e2e suite inside the container. Baseline numbers and query plans for
drill 03 are recorded in its plan file — that is the `before` column cards 08/09/10 get
compared against, and drill 04's plan records what those same queries do at 2.5M rows.

## Known issues

1. Frontend has no test runner.
2. ~~Backend doesn't log any endpoint locally.~~ Fixed in drill 06 — both apps log structured
   JSON, one line per request at `info`. Note the reverse concern now applies: `debug` in
   production would be expensive, and the query string is logged in full.
3. Backend: health, info, postgres, and redis doesnt have any tests. (Drill 06 added
   `request-id.e2e-spec.ts`, which exercises `/health` but does not test `HealthService`.)
4. `AppController`/`AppService` are still `nest new` scaffolding returning `'Hello World!'`,
   kept only because `test/app.e2e-spec.ts` asserts on them.

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed first.
- Keep these files short. Bloat is what stops them being read.

## Evolution of decisions
