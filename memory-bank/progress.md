# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`; this file is only what a session needs *now*.

## Current focus

None.

## Next step

Drill 13, or card 26 (the outbox) — drill 12 named the partial-failure problem and did not build it.

## Active plan

None open — every plan file in `plans/` is shipped. `history.md` lists them with results.

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
Every instrument and toggle is listed in `techContext.md` under Commands.

`pnpm db:test` runs the e2e suite inside the container (100 tests). Four suites are *expected* to
fail, and a green run of any of them means the switch stopped switching: `pnpm db:test:naive`
(`LIST_STRATEGY=naive`) fails **two** query-budget assertions, `pnpm db:test:notiebreak`
(`KEYSET_TIEBREAK=off`) fails **one** — the tie-block walk, which returns 9 of 12 rows with no error
— `pnpm db:test:like` (`SEARCH_STRATEGY=like`) fails **one**, the stemming assertion, and
`pnpm db:test:noidem` (`IDEMPOTENCY=none`) fails **three**. `pnpm db:test:redis` fails **one** for a
different reason: not a broken switch, but the Redis arm's real failure mode — a concurrent duplicate
gets a 202 instead of a conversation id. `db:test:constraint` and `db:test:donothing` are expected
green; they are drill 12's DONE WHEN as a test.

`pnpm db:storm fire` writes 3,000 rows into whichever org it measures and cleans them up itself, but
a k6 `pnpm load ingest` run does **not** — k6 has no database connection. Delete rows with a
`k6-` prefix on `provider_event_id` before running any drill 05/09/10 baseline.

Baseline numbers and query plans for drill 03 are in its plan file — the `before` column cards 09
and 10 were compared against; drill 04's plan records the same queries at 2.5M rows.

`db:search writes` leaves several hundred MB of dead tuples behind (rolled-back COPYs), so
`pg_relation_size('messages')` reads high until autovacuum catches up: take size numbers before it
or after a `VACUUM`.

## Known issues

1. Frontend has no test runner — and it now has a `"use client"` component and a Route Handler with
   no coverage at all. Drill 10 verified load-more by hand in a browser; nothing guards it.
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
5. **The offset arm has no depth cap.** `?page=100000` is still a legal, slow request, and the cap
   is a product decision (400? empty page?) rather than something to guess at — named in drill 10's
   plan, not built.
6. **The GIN index depends on a superuser catalog change that nothing guards.**
   `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF` (migration 007) does not survive a
   `pg_dump`/restore or a major-version upgrade, and there is no check for it — the symptom is
   search silently going back to a 3.6-second sequential scan. `check:tenancy` would be the natural
   home for a `pg_proc.proleakproof` assertion; not built.
7. **`/search` has no test at all**, same as the rest of the frontend (issue 1). And search results
   have no paging — `limit` only, no cursor.
8. **Interior-substring search is not supported and that is a recorded decision.** `xport` finds
   nothing while `LIKE '%xport%'` finds 164,508 rows. The trigram index that would answer it is
   priced (2,159 MB, 123s) and rejected in drill 11's plan.
9. **`POST /ingest` authenticates with one uncached query per request**, including the ~70% of a
   duplicate storm that is about to be discarded. The Redis guard removes the *write* from the
   duplicate path, not the read. Caching the key lookup is the obvious next move and belongs to a
   caching drill; the cost is visible in `db:storm`'s numbers rather than hidden.
10. **The ingest partial-failure case is named and not built.** Once a side effect exists, the row
   and the effect are no longer one atomic unit and `ON CONFLICT` stops being sufficient — a retry
   that finds the row returns 200 and the effect never runs. Needs an outbox. Card 26.
11. **Logging is now a cost to watch, not an absence.** `LOG_LEVEL=debug` in anything resembling
   production would be expensive, and `url` is logged with its query string in full — safe for
   today's parameters, not for a token or an email.

## Releases

| Tag | Version | Milestone | Notes |
|---|---|---|---|
| [drill/09](https://github.com/Shahzayb/drills/releases/tag/drill/09) | 0.9.0 | `drill/09` (closed) | First release actually cut. Tags `drill/01` and `drill/02` exist locally, were never pushed, and have no release. |
| [drill/10](https://github.com/Shahzayb/drills/releases/tag/drill/10) | 0.10.0 | `drill/10` | Keyset pagination, the depth chart, and the load-more UI. |
| [drill/11](https://github.com/Shahzayb/drills/releases/tag/drill/11) | 0.11.0 | `drill/11` | Full-text search, the GIN index, and the leakproof flag it depends on. |

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.
