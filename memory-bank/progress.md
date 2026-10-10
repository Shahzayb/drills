# Progress

Current state and next action. `history.md` holds each drill's result.

## Current focus

None.

## Next step

Card 23 shipped. Card 24 re-runs `pnpm db:ratelimit` and drill 22's sweep across replicas; drill 23's
`--profile drain` already runs two. Card 26 (the outbox) replaces drill 19's `NOTIFY`. Card 29 is card
20's stretch in full. Card 30 starts from drill 15's worker and owes it a lease (issue 21). Open: whether
readiness keeps its dependency checks (issue 57).

## Active plan

None open. Every plan in `plans/` is shipped.

## Live validation

`pnpm docker:up`, then `pnpm db:reset`. `pnpm db:test` runs the backend e2e suite (161 tests) on 6 jest
workers; at jest's default 13 the 1GB dev container OOMs.

Each red run MUST fail exactly this many tests (arms in `package.json`); a green red run means the
switch stopped switching. `db:test:naive` 2 (query budget) · `:notiebreak` 1 · `:like` 1 ·
`:noidem` 3 · `:redis` 1 · `:rmw` 2 · `:lww` 4 · `:buffer` 6 · `:skiplast` 15 (two suites) ·
`:nocache` 1 · `:ttlonly` 2 · `:stampede` 2 · `:nojitter` 1 · `:fixed` 1 · `:fixedrmw` 2 ·
`:bucketrmw` 1 · `:nodrain` 4. Green: `:constraint`, `:donothing`, `:locking`, `:serializable`, `:pessimistic`,
`:restart`, `:invalidate`, `:statswait`, `:pool2`.

`pnpm test:ui` runs Playwright (6 tests) on the host (`pnpm exec playwright install chromium`
once). Red runs: `ASSIGN=lww docker compose up -d nest_server` fails the conflict test;
`E2E_STATS=blocking` fails the streaming test; `E2E_CACHE=cached` fails three.
`E2E_CACHE=nostore|blanket` are green. Every fixture that writes through the API calls
`POST /api/revalidate` afterwards.

Before measuring:

- `pnpm ui:paint` and `pnpm load page` need `COMPOSE_PROJECT_NAME=drills pnpm docker:up:prod`
  (`--allow-dev` overrides). `?stats=off` drops the widget; `?cache=nostore` forces the API and the
  database on every load.
- A write made by hand (curl, a `db:*` instrument, a seed) leaves Next's data cache stale until
  `POST /api/revalidate {org, id, cache: "blanket"}` or the fetch-cache directory is deleted.
  Next's cache survives container recreates (bind-mounted `.next`).
- `pnpm db:import` files and the API's spooled uploads live in container `/tmp`; a recreate
  wipes them. Import runs clean up their rows at the start of the next run, not the end.
- `IMPORT=buffer` kills the API process; `docker compose restart nest_server` after each run.
- `pnpm db:quota bench`, and `pnpm load pool` past pool 96, need `PG_MAX_CONNECTIONS=200` on
  `postgres_db`, repeated on every compose call.
- `db:search writes` leaves dead tuples; take size numbers after a `VACUUM`.
- `pnpm db:entitle metrics` keeps its snapshot in container `/tmp`; bracket a k6 run with two
  calls.
- `pnpm db:stampede` needs `PG_PRELOAD=pg_stat_statements`. Run `run` at `STATS_TTL_S=300` so the
  forced expiry is the only one in the window.
- `pnpm drain` mints an API key when `--api-key` is empty; its `db/reports/*storm-key*` output holds
  the plaintext key, so delete it. Each run imports 300k rows into org `drill-23-drain`: delete them
  by `conversation_id` as the owner under `SET session_replication_role = replica` (issue 58). Then
  `docker compose --profile drain rm -sfv api_a api_b lb` and `docker volume rm drills_drain_imports`.
- `pnpm load ingest` leaves rows behind (k6 has no database connection). Before a drill 05/09/10
  baseline, as the owner:

```sql
CREATE TEMP TABLE doomed AS
  SELECT id FROM conversations
   WHERE org_id = 1 AND provider_event_id IS NOT NULL
     AND (provider_event_id LIKE 'k6-%' OR provider_event_id LIKE 'probe-%');
DELETE FROM usage_events  WHERE conversation_id IN (SELECT id FROM doomed);
DELETE FROM messages      WHERE conversation_id IN (SELECT id FROM doomed);
DELETE FROM conversations WHERE id IN (SELECT id FROM doomed);
```

## Known issues

Numbered for reference from plans; gaps are retired numbers.

**Coverage**

1. Frontend tests cover only the assign conflict, the stale read and streaming.
2. No backend unit tests; `RedisService` and `InfoController` failure branches are untested.

**Tenancy and auth (stubbed on purpose; see `projectbrief.md`)**

4. `organizations` and `users` have no RLS policy (decision, and a real leak surface).
41. `POST /api/revalidate`, the status Server Action and `PUT /entitlements/plan` are
    unauthenticated. `cache: "blanket"` on the whale, or `Cache-Control: no-cache` on
    `GET /messages/stats`, costs a 5GB scan.

**Query paths**

5. The offset arm has no depth cap; the cap is a product decision.
6. Nothing guards migration 007's LEAKPROOF flag; losing it returns search to a 3.6s scan.
7. Search results have no paging (limit only).
8. Interior-substring search is rejected by decision (trigram index priced at 2,159MB).
33. Nothing reads `last_message_at`; its index was priced at 118.6MB and rejected.
36. The whale's stats aggregate is a 5GB scan once per TTL; the 64MB `/dev/shm` fails ~10
    concurrent parallel scans.
37. The sentiment split is two word lists (`method: 'lexicon'`).
56. Search and list reads share one pool, so a saturated search queue delays cheap reads (FIFO).

**Ingest, quota and billing**

9. The API-key lookup is uncached (a 429 still costs a Postgres query); caching it needs a
   revocation path first.
10. The ingest partial-failure case needs an outbox (card 26).
11. The monthly quota (`quota_limit`) is never enforced; drill 19 added only a per-plan rate limit.
12. The billing period truncates in UTC; orgs carry no billing timezone.
13. No job reconciles `usage_counters` against the `usage_events` ledger.
14. `Number()` on `bigint` caps counters at 2^53 (meter, import counters, widget).
15. Write skew across two counter rows is demonstrated and undefended.

**Assign and the UI**

17. Load-more pages do not converge after `refresh()`; a claim on page 3 stays optimistic.
18. Nobody but the clicker learns about a claim, and Back hides another agent's write.
19. `version` is a raw integer on the wire; `ETag`/`If-Match`/412 is the standard shape.
20. The `lww`, `?stats=blocking` and `?cache=cached` arms are reachable on purpose.

**Imports and schema changes**

21. The import worker has no lease or heartbeat. A graceful shutdown leaves a job `failed` and
    resumable; a crash, SIGKILL or the shutdown deadline leaves it `running`, and `retry` refuses it.
22. The upload spool is ephemeral; object storage is the answer.
23. Nothing limits import concurrency; it shares the pool with every request (card 30).
24. One bad row kills an import; no quarantine or `rows_failed`.
25. Resume skips the writes and still re-parses from row zero.
26. `POST /imports` has no size, rate or quota limit.
28. `IMPORT_BATCH_ROWS` is one global; a 40-column table hits the 65,535-parameter ceiling at
    1,600 rows.
29. The browser upload buffers (`request.formData()`); a presigned PUT is the fix.
30. Nothing gates the backfill between migrations 015 and 016, and it keeps no progress row.
31. The backfill's 10ms pause is not a feedback loop on load.
32. Imported rows have `last_message_at` older than their messages; only the backfill's
    `AND col IS NULL` guard protects them, untested.
34. `lock_timeout` is on migration 016 only; nothing checks later migrations.

**Caching (drills 18–21)**

42. Writes outside the Server Actions never revalidate Next's cache (ingest, imports, curl,
    instruments); the list and row stay stale until a tag expires.
43. The org-wide list tag evicts every list variant on each status change.
44. The widget is up to 60s stale and says only `Ns old`.
48. The cache-aside fill race beats the `DEL` for a full TTL on every cache arm (versioned fill or
    lease is the fix).
49. `plan_limits` edits invalidate nothing; they wait out every key's TTL.
50. Redis is on every org-scoped request with a 2s timeout and no circuit breaker; stopped under
    load, p50 rose to 0.8–3.4s.
51. The ingest limiter fails open, and a 400 costs a token.
53. `notify` drops messages while its listener is down; a listener stuck in a transaction can fill
    the NOTIFY queue and fail plan-changing commits.
54. Entitlement misses are not coalesced; a cold key under 2,000 concurrent ingests cost 40–209
    Postgres reads (drill 21).
55. Stats waiters poll every 25ms; no in-process single-flight; a flushed cache refills every key
    at once.

**Shutdown and health (drill 23)**

57. Readiness checks Postgres and Redis through the request pool. Under overload the check times
    out and the LB can mark every replica DOWN: one slow scan during a restart cost 203–535 × 503.
58. `usage_events.conversation_id` (`ON DELETE SET NULL`) has no index, so each deleted
    conversation scans the ledger; a 2.96M-row delete ran 8 minutes before it was cancelled.
59. In-flight requests are counted but unbounded; no 503 + `Retry-After` backpressure.

**Instruments and observability**

16. `url` is logged with its full query string; `LOG_LEVEL=debug` would be expensive.
35. k6 report directories say `vus10` for arrival-rate runs.
40. `ui:paint` draws the last round, not the median one.
47. A cached page's request id never reaches the API log; `traceparent` still joins in Jaeger.

## Releases

Tag `drill/NN` = version `0.NN.0`, from `drill/09` (`drill/01`/`drill/02` exist locally only).
Since `drill/14`, tagged on the branch before the merge with `--notes`; a pre-merge
`--generate-notes` is a changelog link only. Milestones exist for `drill/09`–`drill/11` only (no
open issues since). Latest: [drill/23](https://github.com/Shahzayb/drills/releases/tag/drill/23).

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made with the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.
