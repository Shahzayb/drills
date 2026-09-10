# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`; this file is only what a session needs *now*.

## Current focus

None.

## Next step

Card 17 (streaming RSC) or SQ3 are drill 16's stated alternatives. Card 30 (the noisy-neighbour
bulk import) has the path it needs — drill 15's worker is an in-process async function sharing the
pool with every request, which is the mechanism card 30 exploits. Card 26 (the outbox) is still open
from drill 12.

## Active plan

None open — every plan file in `plans/` is shipped. `history.md` lists them with results.

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
Every instrument and toggle is listed in `techContext.md` under Commands.

`pnpm db:test` runs the e2e suite inside the container (136 tests). Nine arms are *expected* to
fail, and a green run of any of them means the switch stopped switching: `pnpm db:test:naive`
(`LIST_STRATEGY=naive`) fails **two** query-budget assertions, `pnpm db:test:notiebreak`
(`KEYSET_TIEBREAK=off`) fails **one** — the tie-block walk, which returns 9 of 12 rows with no error
— `pnpm db:test:like` (`SEARCH_STRATEGY=like`) fails **one**, the stemming assertion,
`pnpm db:test:noidem` (`IDEMPOTENCY=none`) fails **three**, and `pnpm db:test:rmw` (`QUOTA=rmw`)
fails **two** — the counter against the request count and against the ledger. `pnpm db:test:redis`
fails **one** for a different reason: not a broken switch, but the Redis arm's real failure mode — a
concurrent duplicate gets a 202 instead of a conversation id. `db:test:constraint` and
`db:test:donothing` are expected green (drill 12's DONE WHEN as a test), and so are
`db:test:locking` and `db:test:serializable` (drill 13's). Drill 14 adds two more:
`pnpm db:test:lww` (`ASSIGN=lww`) fails **four** — every assertion in the concurrent block, because
all twenty claimers are told they won — and `pnpm db:test:pessimistic` is expected green. Drill 15
adds `pnpm db:test:buffer` (`IMPORT=buffer`), which fails **four**: the upload answers 200 instead
of 202, it spends a query per row instead of one, its durable state after a crash is an arbitrary
row rather than a batch boundary, and its retry answers 500 because the work it does synchronously
is what throws. `pnpm db:test:restart` (`IMPORT_ON_FAIL=restart`) is expected **green**, and that is
the point of it — restarting an import from row zero is slower and just as correct, because drill
12's partial unique index makes a re-imported row a no-op. Drill 16 adds `pnpm db:test:skiplast`
(`LAST_MESSAGE=skip`), which fails **15** across two suites — the whole ingest write path plus the
quota counter riding on it, because a NOT NULL constraint deployed ahead of the code that fills the
column is not a degradation, it is a stop.

`pnpm test:ui` runs the frontend's Playwright suite (3 tests) on the **host** against the running
container. One-time setup: `pnpm exec playwright install chromium`. It also has a required red run —
`ASSIGN=lww docker compose up -d nest_server && pnpm test:ui` fails the conflict test, because the
losing browser is never told anything.

`pnpm db:import` writes into `/tmp` inside the container, and **recreating the container wipes it** —
both the generated CSVs and the API's own spooled uploads. `docker compose restart nest_server`
keeps them, `up -d --force-recreate` does not, so an arm switch means regenerating. A run also
leaves its rows in the org it measured: `fire` and `resume` clean `conversations` with
`provider_event_id LIKE 'import:%'` at the START of a run, not the end, so the last run's rows are
still there until the next one. Clear them by hand before any drill 05/09/10 baseline.

**`IMPORT=buffer` kills the API process and nothing restarts it.** V8's heap limit fires at 511MB
against the container's 1024MB, `nest start --watch` does not bring the process back, and the
container stays up reporting unhealthy — so the next command gets `ECONNREFUSED`.
`docker compose restart nest_server` after every buffered run.

`pnpm db:storm fire` and `pnpm db:quota fire` write rows into whichever org they measure and clean
them up themselves, but a k6 `pnpm load ingest` run does **not** — k6 has no database connection.
Before any drill 05/09/10 baseline:

```sql
CREATE TEMP TABLE doomed AS
  SELECT id FROM conversations
   WHERE org_id = 1 AND provider_event_id IS NOT NULL
     AND (provider_event_id LIKE 'k6-%' OR provider_event_id LIKE 'probe-%');
DELETE FROM usage_events  WHERE conversation_id IN (SELECT id FROM doomed);
DELETE FROM messages      WHERE conversation_id IN (SELECT id FROM doomed);
DELETE FROM conversations WHERE id IN (SELECT id FROM doomed);
```

`provider_event_id IS NOT NULL` is what lets the partial unique index answer that instead of
sequential-scanning 2.5M rows. The three deletes are not optional and the one-line version
recorded here before drill 16 was wrong: an ingested conversation has a message and a usage_event
pointing at it, and a bare `DELETE FROM conversations` fails on `messages_conversation_id_fkey`.
`probe-%` is what `pnpm db:schema locks` and `index` tag their probe rows with.

`pnpm db:quota bench` needs `PG_MAX_CONNECTIONS=200 docker compose up -d postgres_db` — it opens one
connection per concurrent transaction and the default 100 has no headroom over the app's pool. The
default is deliberately unchanged, so every recorded baseline still describes the same server. Note
that a later `docker compose up -d nest_server` without the variable set recreates `postgres_db` back
to 100; put it in `.env` for the duration of a sweep.

Baseline numbers and query plans for drill 03 are in its plan file — the `before` column cards 09
and 10 were compared against; drill 04's plan records the same queries at 2.5M rows.

`db:search writes` leaves several hundred MB of dead tuples behind (rolled-back COPYs), so
`pg_relation_size('messages')` reads high until autovacuum catches up: take size numbers before it
or after a `VACUUM`.

## Known issues

**Drill 16 added five (30-34), and issue 29 is unchanged.**

1. Frontend coverage is one page and one flow. Drill 14 gave it a test runner (Playwright,
   `pnpm test:ui`) and three tests, all about the assign conflict. The Route Handler, load-more,
   `/search` and the filters still have none.
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
11. **Nothing enforces the quota.** `usage_counters.quota_limit` exists and no code reads it. Counting
   correctly and rejecting at the limit are different jobs, and drill 13 only did the first.
12. **The billing period is UTC.** `date_trunc('month', now() AT TIME ZONE 'UTC')` — a real meter
   truncates in the org's billing timezone, which the schema does not carry. Invisible for eleven
   months at a time.
13. **Nothing reconciles the counter against the ledger.** The query exists (it is drill 13's test
   assertion) and no job runs it. Drift here is money.
14. **`Number(rows[0].used)` caps the meter at 2^53.** `bigint` arrives from `pg` as a string.
15. **The write-skew case is demonstrated and not defended.** `db:quota skew` shows that `atomic`
   cannot hold an invariant across two counter rows, but the endpoint writes one metric, so the day a
   second counter joins that path the shipped arm is wrong and no test says so.
16. **Logging is now a cost to watch, not an absence.** `LOG_LEVEL=debug` in anything resembling
   production would be expensive, and `url` is logged with its query string in full — safe for
   today's parameters, not for a token or an email.
17. **Appended pages do not converge.** `refresh()` in the assign Server Action re-renders page 1,
   which is a live prop. Rows fetched by load-more live in `useState` and keep whatever they were
   showing, so a claim on page 3 stays optimistic forever.
18. **Nobody but the clicker is told.** A claim corrects one browser. Every other agent's inbox goes
   on showing the ticket as unassigned until something re-renders it. Needs a subscription, and
   drill 14 explicitly did not build one.
19. **`version` is a raw integer on the wire.** It leaks a row's write rate and invites guessing.
   `ETag` / `If-Match` / `412` is the standard shape for the same mechanism.
20. **The `lww` arm is a live route to a silent data bug.** It is deliberate — a red run is the only
   proof a concurrency test works — and it is an environment variable away from being served.
21. **The import worker has no lease, no heartbeat and no reaper.** A crashed worker leaves its job
   on `status = 'running'` forever, and `/imports` polls it every two seconds for as long as the tab
   is open. `locked_until` plus a sweeper is the shape; not built.
22. **The upload spool is ephemeral.** `/tmp/imports/<jobId>.csv` does not survive a container
   recreate, so a retry after a redeploy has no file to read. Object storage with the key on the job
   row is the answer.
23. **Nothing limits import concurrency.** The worker is an in-process async function sharing the
   pool of ten with every request. Two tenants importing at once is card 30's scenario, and that is
   deliberate rather than overlooked.
24. **A single bad row kills the whole import.** There is no quarantine table and no `rows_failed`.
   A customer's 200MB export will have a handful of bad rows and re-uploading the file is not an
   answer.
25. **Resume skips the writes, not the parse.** `from` in csv-parse stops records being emitted, not
   read, so resuming at row 400,000 still runs the parser over 400,000 rows. A byte offset on the
   job row plus record-boundary reporting would fix it.
26. **`POST /imports` has no size limit, no rate limit and no quota check.** A 50GB upload is
   accepted and spooled until the disk fills. `usage_counters.quota_limit` exists and nothing reads
   it (issue 11).
27. **`Number(row.rows_read)` caps every import counter at 2^53**, same as issue 14.
28. **The batch size is one global.** 1,000 is right for this row shape. A table with 40 columns
   reaches the 65,535 bind-parameter ceiling at 1,600 rows, and nothing notices until the protocol
   error — which reports a *wrapped* count and so names a number that was never sent.
29. **The browser upload buffers.** A file input sends `multipart/form-data` and reading the part
   back out means `request.formData()`, which materialises it. The page says so beside the control;
   the fix is a presigned PUT direct to object storage.
30. **The backfill is a script somebody has to remember to run, between two migrations, in the right
   order, and nothing gates it.** `pnpm db:migrate` will run migration 016 against an unbackfilled
   table; it fails loudly on `contains null values`, which is the good case, but "the deploy fails"
   is not "the deploy is impossible". It also has no progress row, no lease and no resume marker —
   it re-derives its position from `IS NULL` every run, so a stopped run says nothing about how far
   it got. Drill 15's `import_jobs` is the shape that fixes this and was not reused.
31. **Nothing throttles the backfill against live load.** The 10ms pause is a constant, not a
   feedback loop on replication lag or on the endpoint's p99.
32. **The imported rows disagree with the backfill's own oracle and nothing says so.** An import
   writes `last_message_at` from the CSV while the messages it creates get `created_at = now()`, so
   for those rows `last_message_at < max(messages.created_at)`. The `AND col IS NULL` guard inside
   the backfill's UPDATE is the only thing stopping a re-run from "fixing" them into being wrong,
   and there is no test for that guard.
33. **Nothing reads `last_message_at`.** It is in the list response and no query sorts or filters by
   it. `(org_id, last_message_at DESC, id DESC)` is priced at 118.6MB in drill 16's plan and
   rejected, so shipping the sort would ship a sequential scan on the whale.
34. **`lock_timeout` is on migration 016 only.** Nothing stops the next `ALTER TABLE` anyone writes
   from omitting it, and `check:tenancy`/`check:arms` do not look for it. The deploy tooling is
   where it belongs.

## Releases

| Tag | Version | Milestone | Notes |
|---|---|---|---|
| [drill/09](https://github.com/Shahzayb/drills/releases/tag/drill/09) | 0.9.0 | `drill/09` (closed) | First release actually cut. Tags `drill/01` and `drill/02` exist locally, were never pushed, and have no release. |
| [drill/10](https://github.com/Shahzayb/drills/releases/tag/drill/10) | 0.10.0 | `drill/10` | Keyset pagination, the depth chart, and the load-more UI. |
| [drill/11](https://github.com/Shahzayb/drills/releases/tag/drill/11) | 0.11.0 | `drill/11` | Full-text search, the GIN index, and the leakproof flag it depends on. |
| [drill/12](https://github.com/Shahzayb/drills/releases/tag/drill/12) | 0.12.0 | none (no open issues to attach) | Idempotent ingest: unique constraint vs Redis `SETNX`, both hit exactly 3,000/10,000 under a concurrent duplicate storm. |
| [drill/13](https://github.com/Shahzayb/drills/releases/tag/drill/13) | 0.13.0 | none (no open issues to attach) | The lost update: a read-modify-write counter loses 84 of 100 concurrent increments; atomic `UPDATE` shipped over `FOR UPDATE` and `SERIALIZABLE`. |
| [drill/14](https://github.com/Shahzayb/drills/releases/tag/drill/14) | 0.14.0 | none (no open issues to attach) | Optimistic locking on assignment: 50 agents claim one ticket and a version check leaves exactly one winner, with the losing browser converging on the truth without a reload. **Tagged on the branch before the merge**, at the request of the release, so `drill/14` points at `chore(release): 0.14.0` rather than at a merge commit the way `drill/13` does. `--generate-notes` produced only a changelog link for that reason — there was no merged PR to attribute commits to — so the body was written by hand. |
| [drill/15](https://github.com/Shahzayb/drills/releases/tag/drill/15) | 0.15.0 | none (no open issues to attach) | Streaming CSV import: peak memory flat at ~120MB from a 20MB file to a 400MB one, against a naive version that dies in 2.63 seconds having written nothing. Tagged on the branch before the merge, the `drill/14` precedent. |
| [drill/16](https://github.com/Shahzayb/drills/releases/tag/drill/16) | 0.16.0 | none (no open issues to attach) | Zero-downtime schema change: the naive migration held ACCESS EXCLUSIVE for 74.7s and failed 76.73% of writes; the same work in four transactions failed none and came in 21% *under* the baseline p99. Tagged on the branch before the merge, the `drill/14` precedent. |

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.
