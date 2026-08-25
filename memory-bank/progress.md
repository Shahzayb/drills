# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`; this file is only what a session needs *now*.

## Current focus

Nothing in flight. Drill 08 landed on 2026-08-17 (N+1 detection: assignee name + tags on the list,
a per-request query counter with a budget, `pg_stat_statements` vs the statement log as the two
zero-app-code detection methods).

**The whale's absolute latency is dominated by card 09's still-open gap, not by anything drill 08
touched.** An isolated `EXPLAIN` put the missing `(org_id, updated_at DESC, id DESC)` index's seq
scan at 154.6ms against the LEFT JOINs' +30ms — and that gap is also why the whale's *k6* numbers
this session were too noisy to trust (10 concurrent VUs thrashing a 128MB `shared_buffers` against
a 230MB+ heap). Fixing card 09 should make the whale's k6 numbers trustworthy for the first time
since drill 05.

## Next step

**Card 09 is next**, believed to be the composite-index card — read that with appropriate
confidence: drill 05 guessed "card 08" would be about `count(*)`/keyset paging and was wrong about
the number, not the technical content (actual card 08, 2026-08-17, was N+1 detection). The
technical prediction stands independent of which card number picks it up:

- **The composite index is where the whale's ~155ms list-query cost lives** — drill 08's isolated
  `EXPLAIN` shows a `Parallel Seq Scan` with no usable index for
  `WHERE org_id = $1 ORDER BY updated_at DESC, id DESC`. Fixing it should also make the whale's k6
  numbers trustworthy again (see Current focus).
- **`count(*)`/keyset paging is real but separate** — `count(*)` is a 33ms index-only scan once
  vacuumed (refuting drill 03's original prediction), a different cost than the list query's
  missing index. Whichever future card covers paging, this is its starting point, not card 09's.

One measurement is still open, unchanged since drill 06: **the pool under load** —
`PostgresService.stats()` sampled *during* a k6 run, or the `pg-pool.connect` spans across a traced
run. Drill 08 predicted the N+1 there would show up as connection **hold time**, not pool
**saturation** (drill 07 already pins one connection per request via `withOrg`), but never actually
sampled `poolStats` to confirm — a real gap, not a closed measurement.

## Active plan

None open — every plan file in `plans/` is shipped. `history.md` lists them with results.

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
`pnpm db:test` runs the e2e suite inside the container; `pnpm db:test:naive` runs the same suite
with `LIST_STRATEGY=naive` and is *expected* to fail one assertion — that's the query-budget proof,
not a broken build. Baseline numbers and query plans for drill 03 are in its plan file — the
`before` column cards 09/10 are compared against; drill 04's plan records the same queries at 2.5M
rows.

`pnpm logs:trace <id>` reconstructs one request across all services. `pnpm trace:on` adds spans, a
collector and Jaeger on `:16686`; `pnpm trace:off` puts it back. `pnpm db:stats:on`/`db:stats`/
`db:stats:reset` drive `pg_stat_statements`, off by default behind
`PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db` (postmaster-context, needs a
recreate — see known issue below for the trap in that).

`pnpm check:tenancy` audits RLS coverage and the serving role's attributes, read-only — the "check
rather than assume" command, which is why there's no separate `rls:status`. Covers five tables:
`conversations`, `messages`, `memberships`, `tags`, `conversation_tags`.

## Known issues

1. Frontend has no test runner.
2. Backend: `HealthService`, `InfoController` and `RedisService` have no tests of their own — the
   e2e suites reach `/health` over HTTP but never exercise the failure branches. `PostgresService`
   is the exception: `schema.e2e-spec.ts` drives it directly.
3. **Nothing under backend `src/` has a unit test** — only e2e coverage. `pnpm test` passes
   trivially (`--passWithNoTests`); the last unit spec was deleted in drill 08 along with the
   scaffolded `AppController`/`AppService` it tested.
4. **`organizations` and `users` have no RLS policy**, and that's a recorded decision, not a gap to
   close casually: `organizations` is the tenant registry rather than tenant-owned data, and `users`
   genuinely has no `org_id` (a person can belong to several orgs). Both are real leak surfaces the
   mechanism doesn't cover.
5. **Logging is now a cost to watch, not an absence.** `LOG_LEVEL=debug` in anything resembling
   production would be expensive, and `url` is logged with its query string in full — safe for
   today's parameters, not for a token or an email.

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.
