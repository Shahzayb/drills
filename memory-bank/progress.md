# Progress

Where things stand and what's next. Not a changelog: `history.md` holds each drill's result.

## Current focus

None.

## Next step

Card 19 shipped. Its stated alternatives are SQ3 (ADRs) and SQ1. Card 26 (the outbox) is open
from drill 12 and is also the durable replacement for drill 19's `NOTIFY`. Card 30 (the
noisy-neighbour bulk import) has the path it needs in drill 15's in-process worker.

## Active plan

None open. Every plan in `plans/` is shipped.

## Live validation

`pnpm docker:up`, then `pnpm db:reset` (migrate + seed). `pnpm db:test` runs the backend e2e
suite in the container (147 tests). Each arm below MUST fail exactly as listed; a green red run
means the switch stopped switching.

| script | arm | expected |
|---|---|---|
| `db:test:naive` | `LIST_STRATEGY=naive` | 2 fail (query budget) |
| `db:test:notiebreak` | `KEYSET_TIEBREAK=off` | 1 fail (tie-block walk) |
| `db:test:like` | `SEARCH_STRATEGY=like` | 1 fail (stemming) |
| `db:test:noidem` | `IDEMPOTENCY=none` | 3 fail |
| `db:test:redis` | `IDEMPOTENCY=redis` | 1 fail (202 for a concurrent duplicate) |
| `db:test:rmw` | `QUOTA=rmw` | 2 fail |
| `db:test:lww` | `ASSIGN=lww` | 4 fail |
| `db:test:buffer` | `IMPORT=buffer` | 4 fail |
| `db:test:skiplast` | `LAST_MESSAGE=skip` | 15 fail across two suites |
| `db:test:nocache` | `ENTITLEMENT_CACHE=off` | 1 fail (the hit assertion) |
| `db:test:ttlonly` | `ENTITLEMENT_CACHE=ttl` | 2 fail (both API-path upgrade tests) |
| `db:test:constraint`, `:donothing`, `:locking`, `:serializable`, `:pessimistic`, `:restart`, `:invalidate` | — | green |

`pnpm test:ui` runs Playwright (6 tests) on the host (`pnpm exec playwright install chromium`
once). Red runs: `ASSIGN=lww docker compose up -d nest_server` fails the conflict test;
`E2E_STATS=blocking` fails the streaming test; `E2E_CACHE=cached` fails three.
`E2E_CACHE=nostore|blanket` are green. Every fixture that writes through the API calls
`POST /api/revalidate` afterwards.

Before measuring:

- `pnpm ui:paint` and `pnpm load page` need `COMPOSE_PROJECT_NAME=drills pnpm docker:up:prod`
  (`--allow-dev` overrides). The whale's aggregate ranges 1.3–3.5s across a session, so compare
  within one sitting. Add `?stats=off` to a `/conversations` URL measuring something else and
  `?cache=nostore` to force the API on every load.
- A write made by hand (curl, a `db:*` instrument, a seed) leaves Next's data cache stale until
  `POST /api/revalidate {org, id, cache: "blanket"}` or the fetch-cache directory is deleted.
  Next's cache survives container recreates (bind-mounted `.next`).
- `pnpm db:import` files and the API's spooled uploads live in container `/tmp`; a recreate
  wipes them. Import runs clean up their rows at the start of the next run, not the end.
- `IMPORT=buffer` kills the API process; `docker compose restart nest_server` after each run.
- `pnpm db:quota bench` needs `PG_MAX_CONNECTIONS=200` on `postgres_db`, repeated on every
  compose call for the sweep.
- `db:search writes` leaves hundreds of MB of dead tuples; take size numbers after a `VACUUM`.
- `pnpm db:entitle metrics` keeps its snapshot in container `/tmp`; bracket a k6 run with two
  calls.
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

1. Frontend tests cover the assign conflict, the stale read and streaming only: the Route
   Handlers, load-more, `/search`, `/imports` and the filters have none.
2. No backend unit tests; `pnpm test` passes on `--passWithNoTests`. `HealthService`,
   `InfoController` and `RedisService` failure branches are untested.

**Tenancy and auth (stubbed on purpose; see `projectbrief.md`)**

4. `organizations` and `users` have no RLS policy (decision, and a real leak surface).
41. `POST /api/revalidate`, the status Server Action and `PUT /entitlements/plan` are
    unauthenticated. `cache: "blanket"` on the whale costs the next reader a 5GB scan.

**Query paths**

5. The offset arm has no depth cap; the cap is a product decision.
6. Nothing guards migration 007's LEAKPROOF flag; losing it silently returns search to a 3.6s scan.
   `check:tenancy` is the natural home for a `proleakproof` assertion.
7. Search results have no paging (limit only).
8. Interior-substring search is rejected by decision (trigram index priced at 2,159MB).
33. Nothing reads `last_message_at`; its index was priced at 118.6MB and rejected.
36. The stats widget still costs the whale a 5GB scan per fill (every 60s, drill 18).
37. The sentiment split is two word lists (`method: 'lexicon'`).

**Ingest, quota and billing**

9. The API-key lookup is uncached. Caching it would keep a revoked key working for the TTL, so
   revocation needs its own path first.
10. The ingest partial-failure case needs an outbox (card 26).
11. The monthly quota (`quota_limit`) is never enforced; drill 19 added only a per-plan rate limit.
12. The billing period truncates in UTC; orgs carry no billing timezone.
13. No job reconciles `usage_counters` against the `usage_events` ledger.
14. `Number()` on `bigint` caps counters at 2^53 (meter, import counters, widget).
15. Write skew across two counter rows is demonstrated and undefended.

**Assign and the UI**

17. Load-more pages do not converge after `refresh()`; a claim on page 3 stays optimistic.
18. Nobody but the clicker learns about a claim; needs a subscription. Another agent's write is
    also invisible on Back (`stale-status.spec.ts` asserts it).
19. `version` is a raw integer on the wire; `ETag`/`If-Match`/412 is the standard shape.
20. The `lww`, `?stats=blocking` and `?cache=cached` arms are reachable on purpose.

**Imports and schema changes**

21. The import worker has no lease, heartbeat or reaper; a crash leaves a job `running` forever.
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

**Caching (drills 18, 19)**

42. Writes outside the Server Actions never revalidate Next's cache (ingest, imports, curl,
    instruments); the list and row stay stale until a tag expires.
43. The org-wide list tag evicts every list variant on each status change.
44. The widget is up to 60s stale and says only `Ns old`.
48. The cache-aside fill race beats the `DEL` for a full TTL on every cache arm (versioned fill or
    lease is the fix).
49. `plan_limits` edits invalidate nothing; they wait out every key's TTL.
50. Redis sits on every org-scoped request with a 2s command timeout and no circuit breaker.
51. The ingest limiter is a fixed window (2× burst across a boundary) and fails open.
53. `notify` loses messages while its listener is disconnected and does not flush on reconnect;
    a listener stuck in a transaction can fill the NOTIFY queue and fail plan-changing commits.
54. Concurrent misses are not coalesced; a cold key costs one Postgres read per concurrent request.

**Instruments and observability**

16. `url` is logged with its full query string; `LOG_LEVEL=debug` would be expensive.
35. k6 report directories say `vus10` for arrival-rate runs.
40. `ui:paint` draws the last round, not the median one.
47. A cached page's request id never reaches the API log; `traceparent` still joins in Jaeger.

## Releases

From `drill/14` on, each release is tagged on its branch before the merge. No milestones since
`drill/11`: there were no open issues to attach.

| Tag | Version | Notes |
|---|---|---|
| [drill/09](https://github.com/Shahzayb/drills/releases/tag/drill/09) | 0.9.0 | First release cut; milestone `drill/09` (closed). `drill/01`/`drill/02` exist locally only. |
| [drill/10](https://github.com/Shahzayb/drills/releases/tag/drill/10) | 0.10.0 | Keyset pagination; milestone `drill/10`. |
| [drill/11](https://github.com/Shahzayb/drills/releases/tag/drill/11) | 0.11.0 | Full-text search; milestone `drill/11`. |
| [drill/12](https://github.com/Shahzayb/drills/releases/tag/drill/12) | 0.12.0 | Idempotent ingest. |
| [drill/13](https://github.com/Shahzayb/drills/releases/tag/drill/13) | 0.13.0 | The lost update. Tagged on the merge commit. |
| [drill/14](https://github.com/Shahzayb/drills/releases/tag/drill/14) | 0.14.0 | Optimistic locking. `--generate-notes` gave only a changelog link (no merged PR yet); body written by hand. |
| [drill/15](https://github.com/Shahzayb/drills/releases/tag/drill/15) | 0.15.0 | Streaming CSV import. |
| [drill/16](https://github.com/Shahzayb/drills/releases/tag/drill/16) | 0.16.0 | Zero-downtime schema change. |
| [drill/17](https://github.com/Shahzayb/drills/releases/tag/drill/17) | 0.17.0 | Streaming the inbox with Suspense. |
| [drill/18](https://github.com/Shahzayb/drills/releases/tag/drill/18) | 0.18.0 | Next's cache layers. PR #17. |

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made with the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.
