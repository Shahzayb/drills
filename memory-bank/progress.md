# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`; this file is only what a session needs *now*.

## Current focus

None.

## Next step

Drill 12

## Active plan

None open — every plan file in `plans/` is shipped. `history.md` lists them with results.

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
`pnpm db:test` runs the e2e suite inside the container (83 tests). Three suites are *expected* to
fail, and a green run of any of them means the switch stopped switching: `pnpm db:test:naive`
(`LIST_STRATEGY=naive`) fails **two** query-budget assertions, `pnpm db:test:notiebreak`
(`KEYSET_TIEBREAK=off`) fails **one** — the tie-block walk, which returns 9 of 12 rows with no error
— and `pnpm db:test:like` (`SEARCH_STRATEGY=like`) fails **one**, the stemming assertion.

Baseline numbers and query plans for drill 03 are in its plan file — the `before` column cards 09
and 10 were compared against; drill 04's plan records the same queries at 2.5M rows.

`pnpm logs:trace <id>` reconstructs one request across all services. `pnpm trace:on` adds spans, a
collector and Jaeger on `:16686`; `pnpm trace:off` puts it back. `pnpm db:stats:on`/`db:stats`/
`db:stats:reset` drive `pg_stat_statements`, off by default behind
`PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db` (postmaster-context, needs a
recreate — see known issue below for the trap in that).

`pnpm db:explain <plans|sweep|experiments|stats|keyset>` reads query plans for the list endpoint —
three captures, the selectivity sweep, rejected indexes priced inside a rolled-back transaction, and
OFFSET-at-depth against the cursor. `pnpm db:paging <depths|walk|concurrent>` measures the same
endpoint over HTTP: the depth curve with the arms interleaved, the export tool's cumulative walk, and
the concurrent-insert trace. Knobs reach the container only because the root scripts forward them
with `docker compose exec -e` — plain `ORG_ID=150 pnpm db:explain …` did nothing at all until
drill 10.

`pnpm db:search <plans|indexes|gaps|writes>` is drill 11's instrument: LIKE vs full-text search with
both plans, the build time and on-disk size of five candidate indexes each built in a rolled-back
transaction, the inputs where the two disagree, and the write-throughput arms. `db:search writes`
leaves several hundred MB of dead tuples behind (rolled-back COPYs) — `pg_relation_size('messages')`
reads high until autovacuum catches up, so size numbers should be taken before it or after a
`VACUUM`.

`pnpm check:tenancy` audits RLS coverage and the serving role's attributes, read-only — the "check
rather than assume" command, which is why there's no separate `rls:status`. Covers five tables:
`conversations`, `messages`, `memberships`, `tags`, `conversation_tags`.

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
9. **Logging is now a cost to watch, not an absence.** `LOG_LEVEL=debug` in anything resembling
   production would be expensive, and `url` is logged with its query string in full — safe for
   today's parameters, not for a token or an email.

## Releases

| Tag | Version | Milestone | Notes |
|---|---|---|---|
| [drill/09](https://github.com/Shahzayb/drills/releases/tag/drill/09) | 0.9.0 | `drill/09` (closed) | First release actually cut. Tags `drill/01` and `drill/02` exist locally, were never pushed, and have no release. |
| [drill/10](https://github.com/Shahzayb/drills/releases/tag/drill/10) | 0.10.0 | `drill/10` | Keyset pagination, the depth chart, and the load-more UI. |

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.
