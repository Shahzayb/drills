# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`; this file is only what a session needs *now*.

## Current focus

### Drill/09 — Make the planner refuse your index

**What's going on.** Someone will always say "it's slow, add an index." Sometimes that works. Sometimes Postgres looks at your new index, estimates the filter matches 30% of the table, decides a sequential scan is genuinely cheaper, and ignores it — and engineers who've never watched that happen argue with the planner instead of reading the row estimates. The senior answer to "how do you decide what to index" is a story about the time the index didn't get used.

```
TITLE     — Design a composite index for the inbox filter, then produce a case where
            Postgres is right to ignore it
SCENARIO  - The list filters by org and status over a date range and sorts by updated_at.
            It's a sequential scan across 2.5M rows. You add an index; small orgs get
            fast and the whale org doesn't move. Your teammate wants to add three more
            indexes and you need to explain why that's the wrong instinct.
WHY       — "Why didn't the planner use your index?"
TIMEBOX   — 2 evenings (~6h)
PREREQS   — 04, 08
BUILDS    — filter + date range on the list endpoint and the page · the composite index
NEW TECH  — EXPLAIN (ANALYZE, BUFFERS), pg_stats, ANALYZE.
            Budget 45 min reading one plan closely before you try to improve anything.
THE TASK  — Add status filtering and a date range to the endpoint and the UI. Capture
            EXPLAIN (ANALYZE, BUFFERS) on the whale org's query before any index.
            Design a composite index. Decide the column order deliberately and write the
            reasoning down *before* you measure. Capture the plan after.
            Then deliberately build a query where the index exists and is not used — same
            shape, low selectivity, the whale org's most common status. Capture that plan
            too.
            Compare estimated vs actual rows in each. Then find the tipping point: vary
            the filter until the planner flips, and record the selectivity where it did.
DONE WHEN — Three plans in the writeup — seq scan, index scan, index-ignored — each with
            timing and buffer counts. The selectivity threshold where the planner flipped,
            found empirically. Your before-you-measured reasoning about column order, kept
            in the writeup whether it was right or not.
WRITEUP   — Why that column order, and what happens to the plan if you swap the first two?
            At what selectivity did the planner flip, and does that match the rule of
            thumb you'd have guessed?
            What did BUFFERS tell you that timing alone didn't?
BORED? →  17 (streaming RSC, backend break) or SQ3 (ADRs)
STRETCH   — Add a partial index for open conversations. Measure its size against the full
            index and decide whether the saving justifies another index to maintain.
TOPICS    — relational data layer · system design fluency · observability
```

## Next step

TBD: Drill 10

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
