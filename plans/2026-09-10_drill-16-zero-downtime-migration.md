# Drill 16 — Add a required column to 2.5M rows without taking the site down

**Status:** shipped

Card 16. Prereq was 13. Builds a batched backfill mechanism, a lock watcher, and the first
k6 script in this repo that measures arrival rate rather than concurrency.

## Context

`conversations` needs `last_message_at`. The naive migration — add the column, backfill it,
mark it NOT NULL — reads like a metadata change and is not one. Every statement in a
node-pg-migrate migration runs in one transaction, so the ACCESS EXCLUSIVE lock the first
`ALTER TABLE` takes is held until the last statement commits. The outage is the length of the
whole migration, not the length of any statement in it.

This repo has the pieces to prove that rather than assert it: 2.5M conversations, 10M
messages, a write endpoint (`POST /ingest`), a pinned k6 container, and a pool of 10 with a
2s acquire timeout that turns a blocked table into 500s instead of polite waiting.

Drill 14 already measured the easy half — `ADD COLUMN version integer NOT NULL DEFAULT 1` is
2.398ms, because Postgres 11+ stores a non-volatile default in `pg_attribute.attmissingval`
and rewrites nothing. That fact is what makes this card interesting rather than trivial: the
fast path exists, and knowing when you are *not* on it is the skill.

Why the column is not redundant with `updated_at`: the seed builds `updated_at` as the last
message's timestamp, but `updateStatus()` and drill 14's assign both move `updated_at` on a
write that is not a message. The two diverge the first time anyone touches the row.

## What ships

### Two migrations, split on purpose

`1788998400000_conversations-last-message-at.js` — the expand step.

```sql
ALTER TABLE conversations ADD COLUMN last_message_at timestamptz;
ALTER TABLE conversations ALTER COLUMN last_message_at SET DEFAULT now();
```

Nullable, catalog-only, milliseconds. The `SET DEFAULT` is a separate statement from the
`ADD COLUMN` and that is the point: `ADD COLUMN ... DEFAULT now()` in one statement stamps
every existing row with the migration's own clock — fast *and* silently wrong. It is measured
as an arm below rather than described.

`DEFAULT now()` is correct for new rows here because `POST /ingest` writes the conversation
and its first message in one transaction. It is also what keeps ~18 existing INSERT sites
(ingest, `db/claim.mts`, `db/paging.mts`, `db/storm.mts`, 12 e2e fixtures) unchanged.

`1789084800000_conversations-last-message-at-not-null.js` — the constraint step, and it must
carry `pgm.noTransaction()`:

```sql
ALTER TABLE conversations
  ADD CONSTRAINT conversations_last_message_at_not_null
  CHECK (last_message_at IS NOT NULL) NOT VALID;               -- ACCESS EXCLUSIVE, catalog only

ALTER TABLE conversations
  VALIDATE CONSTRAINT conversations_last_message_at_not_null;  -- SHARE UPDATE EXCLUSIVE

ALTER TABLE conversations
  ALTER COLUMN last_message_at SET NOT NULL;                   -- ACCESS EXCLUSIVE, no scan
```

Three facts the file has to state in its comment block:

- `noTransaction()` is not optional. Inside one transaction the ACCESS EXCLUSIVE from
  `ADD CONSTRAINT` is held across the `VALIDATE`, which reinstates exactly the outage the
  NOT VALID split exists to avoid.
- `SET NOT NULL` is free here only because of the line above it. Postgres 12+ skips the table
  scan when a *validated* CHECK proves no NULL can be present. Without it, `SET NOT NULL`
  scans 2.5M rows under ACCESS EXCLUSIVE.
- The technique is already in this repo. `db/seed.mts` re-adds the messages FK with
  `NOT VALID` then `VALIDATE CONSTRAINT`. This migration is that pattern applied under load.

The `down` of the second migration drops the constraint and the NOT NULL. Both are true
inverses.

### Writers

- `apps/backend/db/seed.mts` — `last_message_at` joins the conversations `COPY` column list,
  carrying the same value as `updated_at`. Exactly correct rather than an approximation: the
  seed already pins the last message to `updated_at`.
- `apps/backend/src/imports/imports.service.ts` — the batch INSERT sets `last_message_at`
  from the row's own `created_at`, alongside the `created_at`/`updated_at` it already passes.
  One more parameter per row, so the 65,535 bind-parameter ceiling arithmetic recorded in
  `techContext.md` has to be re-checked at the new arity.
- `apps/backend/src/ingest/ingest.service.ts` — all three write shapes (`upsert`,
  `plainInsert`, `checkThenInsert`) set `last_message_at` explicitly rather than leaning on
  the default, because the red arm below needs a place to write NULL.

### The red arm

`LAST_MESSAGE` = `write` | `skip`, default `write`, read once at module load in
`ingest.service.ts` next to `IDEMPOTENCY` and `QUOTA`.

`skip` writes `NULL` into `last_message_at`, which the NOT NULL constraint rejects — the
expand/contract ordering failure made executable: the constraint went on before the code that
fills the column. Wiring, all of which `pnpm check:arms` enforces:

- `LAST_MESSAGE=${LAST_MESSAGE:-}` in the `nest_server` `environment:` list.
- `lastMessage: LAST_MESSAGE` in `GET /info`'s arms block, and in `test/arms.e2e-spec.ts`'s
  exact `toEqual`.
- `db:test:skiplast` in the root `package.json`.

### Reads

`lastMessageAt` joins the existing list SELECT in `conversations.service.ts` and the
`ConversationSummary` / `ConversationListItem` types. One column on a query that already
runs — no new query, no new helper.

Deliberately **not** added to the `sort` allowlist. Drill 10's cursor fingerprint is
`sort|status|from|to`, and a sort key with no index behind it is a seq scan on the whale. The
index is priced in the instrument and not shipped.

### `apps/backend/db/schema.mts` — the instrument, `pnpm db:schema <sub>`

Registered in `scripts/measure.ts`'s catalog as `schema`. Uses `db/lib/run.mts` for knobs,
the client, `median`, `header` and `record`, the same as every other instrument.

Two Postgres connections: one runs the DDL, one samples locks every `SAMPLE_MS` (250). The
DDL connection is busy and cannot report on itself.

Both `naive` and `safe` work on a **scratch column** (`last_message_at_naive` /
`last_message_at_safe`) that the run adds and drops. Three reasons: the arms then differ only
in the sequencing, which is the repo's own rule that an A/B must not also differ in whether
something restarted; the run is repeatable on either side of the shipped migration; and the
shipped column is never at risk. The lock is on the table, so the blocking behaviour is
identical.

Subcommands:

- **`naive`** — the whole thing in one transaction, under whatever load is running.
  `SHAPE` = `backfill` (default: add nullable, one `UPDATE` over 2.5M rows, `SET NOT NULL`)
  | `rewrite` (`ADD COLUMN ... NOT NULL DEFAULT clock_timestamp()`, a volatile default, full
  rewrite) | `fastwrong` (`ADD COLUMN ... NOT NULL DEFAULT now()`, catalog-only, which then
  counts how many rows hold a value that is not their true `max(messages.created_at)`).
  `ABORT_AT` (percent, 0 = off) cancels mid-`UPDATE` to show what a rollback costs.
- **`safe`** — the four-step sequence with the batched backfill, same watcher, same output
  shape, so the two summaries line up.
- **`backfill`** — the production-facing one, against the real `last_message_at`. Resumable,
  and the step you actually run once after the first migration. `safe` calls the same
  function with a scratch column name; there is one implementation.
- **`locks`** — two live sessions and a chosen interleaving, the shape `db:storm race` and
  `db:claim race` already use. Prints the lock each statement takes, what it conflicts with,
  and a live `pg_locks` / `pg_blocking_pids()` capture with the waiter's queued mode.
- **`bench`** — the batch ladder in raw SQL: `BATCHES` × `SCAN` (`keyset` | `isnull`) ×
  `PAUSE_MS`. Reports rows/s, longest single transaction, dead tuples added, and
  `n_tup_hot_upd`.
- **`index`** — the stretch. `CREATE INDEX` against `CREATE INDEX CONCURRENTLY` for
  `(org_id, last_message_at DESC, id DESC)` under the same load, then CONCURRENTLY's two
  failure modes a plain build does not have: an interrupted build leaving `indisvalid = false`
  (invisible to the planner, still maintained on every write), and a build that stalls behind
  one idle-in-transaction session. Drops what it builds.

The backfill's batch walk is a **keyset walk over the primary key**, not
`WHERE last_message_at IS NULL LIMIT n`. The `IS NULL` shape re-scans from the start of the
table on every batch — drill 10's `OFFSET` finding wearing different clothes — and `SCAN`
exists to measure that rather than assert it. `conversations.id` is uuidv7, so it is ordered.

The lock capture, on the watcher connection:

```sql
SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
       l.mode, l.granted, now() - a.xact_start AS xact_age,
       pg_blocking_pids(a.pid) AS blocked_by, left(a.query, 60) AS query
  FROM pg_locks l JOIN pg_stat_activity a USING (pid)
 WHERE l.relation = 'conversations'::regclass
 ORDER BY l.granted DESC, a.xact_start;
```

Cleanup is the instrument's own job: drop the scratch column, then `VACUUM conversations`.
Dropping a column does not reclaim the dead tuples the `UPDATE` made, and a run that skips
this leaves the heap permanently larger for every later drill's baseline.

### k6 — steady arrival rate

`k6/conversations-write.ts` — `POST /ingest` with distinct event ids under
`constant-arrival-rate`. Catalogued in `scripts/load.ts` as `write`, knobs `--api-key` (from
`pnpm db:storm key`) and `--rate`. Event ids keep the `k6-` prefix so the cleanup query
recorded in `progress.md` still finds them.

`k6/lib/scenario.ts` gains an arrival-rate branch, strictly additively:

- `RATE` knob (default 50), declared there *and* in `scripts/load.ts`'s catalog with the same
  default. `check:arms` fails when the two disagree.
- `shapeOf()` learns to read `rate`/`timeUnit` off an arrival-rate scenario. Today it falls
  back to `measure.vus ?? VUS` and would print `vus=10` over a run that was about arrival
  rate — the exact class of summary that file's own comments call the defect it exists to
  prevent.
- `warmupFor()` mirrors the arrival-rate shape, shortened.
- `summary()` reports `dropped_iterations`. Without it the naive run's damage is understated:
  when every VU is stuck behind the lock, k6 stops being able to issue requests at all, and
  those missing requests appear in no latency percentile.

The existing `flat()` path stays byte-identical, so the ~60 recorded runs in `k6/reports/`
remain comparable.

### Tests

Extended rather than added:

- `test/schema.e2e-spec.ts` — the column is `attnotnull`, the constraint exists and is
  `convalidated`, and the default is `now()`.
- `test/ingest.e2e-spec.ts` — a created conversation's `last_message_at` equals its first
  message's `created_at`, and a duplicate delivery does not move it. This block is what goes
  red under `LAST_MESSAGE=skip`.
- `test/arms.e2e-spec.ts` — the new arm in the exact `toEqual`.
- `test/imports.e2e-spec.ts` — an imported row's `last_message_at` is the row's own
  timestamp, not the import's wall clock.

## Predictions, recorded before measuring

1. `naive SHAPE=backfill` holds ACCESS EXCLUSIVE for the full migration, 60–150s at 2.5M rows
   against 10M messages, and `POST /ingest` returns 500s from the 2s pool-acquire timeout
   rather than merely getting slow.
2. `naive SHAPE=rewrite` is far shorter than that — drill 14 measured 2,563ms for a volatile
   default on this table — which makes the card's own framing ("add it NOT NULL with a
   default") the *less* damaging of the two naive shapes. Expecting to correct the card here.
3. `naive SHAPE=fastwrong` is under 10ms and leaves ~2.5M rows holding a value that is not
   their true last message time.
4. `safe` produces zero errors and a p99 within 15% of baseline — the noise floor
   `techContext.md` records for a cross-arm comparison, so anything inside it is unproven
   rather than clean.
5. Batch size 1,000 is not the knee for an `UPDATE` the way it is for an `INSERT`. Expecting
   the knee higher, because the per-batch cost here is dominated by the aggregate over
   `messages` rather than by round trips.
6. `SCAN=isnull` degrades superlinearly across the run and `SCAN=keyset` stays flat.

## Results

Postgres 18.6, 2,500,000 conversations, 10,000,000 messages, `shared_buffers=128MB`, pool of
10 with a 2s acquire timeout. All three k6 runs are one sitting against the same starting
table (349MB heap, 0 dead tuples, freshly `VACUUM (ANALYZE)`ed), `constant-arrival-rate` at
50 req/s, 20s warm-up discarded, 90s measured.

### The DONE WHEN

| arm | requests | errors | p50 | p95 | p99 | max | req/s | dropped |
|---|---|---|---|---|---|---|---|---|
| baseline | 4,500 | **0 (0.00%)** | 4.01 | 6.49 | 7.75 | 17.91 | 50.00 | 0 |
| naive | 4,439 | **3,406 (76.73%)** | 2001.07 | 2003.07 | 2005.01 | 60,001 | 49.32 | 61 |
| safe | 4,501 | **0 (0.00%)** | 0.96 | 4.56 | 6.09 | 23.72 | 50.01 | 0 |

`k6/reports/2026-09-10-00*-{baseline,naive-during,safe-during}-conversations-write-*`.

The safe arm's p99 is **6.09ms against the baseline's 7.75ms — 21% below it**, not merely
within a budget. The naive arm's p99 is **259x baseline**, and 61 requests were never sent at
all because every allocated VU was parked behind the lock.

**The naive p50 is 2001.07ms and that number is not the database.** It is
`connectionTimeoutMillis: 2000` on the `pg` pool. Ten connections were queued on the lock, so
every request behind them waited exactly two seconds for a pool slot and then got a 500. The
tail past that — max 60,001ms — is k6's own default HTTP timeout, not a response either.

### Which statement took the lock, and what it blocked

`pnpm db:schema naive`, one transaction:

| statement | ms |
|---|---|
| `ADD COLUMN` (nullable) | 1.01 |
| `SET DEFAULT now()` | 1.04 |
| `UPDATE` … 2.5M rows | 74,389.12 |
| `SET NOT NULL` | 324.67 |

**One transaction, held 74,722.08ms.** The `ALTER TABLE ADD COLUMN` on line one takes ACCESS
EXCLUSIVE in a millisecond and does not give it back until COMMIT. The outage is the length of
the migration, not the length of any statement in it.

The `pg_locks` capture, sampled every 250ms on a second connection:

```
pid 3821  AccessExclusiveLock  granted=true   UPDATE conversations c SET last_message_at_naive …
pid 3745  RowExclusiveLock     granted=false  WITH ingested AS ( INSERT INTO conversations …
… 9 more, all RowExclusiveLock, all Lock/relation
```

296 of 297 samples had a queue. Peak 10 waiters — the pool's whole capacity — every one of
them a `POST /ingest`. Longest wait observed **74,615.89ms**.

`pnpm db:schema locks` proves the conflict matrix rather than quoting it, with a 1500ms
statement timeout on the probing session:

| session A holds | lock | session B tries | blocked |
|---|---|---|---|
| `ALTER TABLE ADD COLUMN` | AccessExclusive | SELECT | **YES** (queued for AccessShare) |
| `ALTER TABLE ADD COLUMN` | AccessExclusive | INSERT | **YES** (queued for RowExclusive) |
| `UPDATE` | RowExclusive | SELECT | no |
| `UPDATE` | RowExclusive | INSERT | no |
| `VALIDATE CONSTRAINT` | ShareUpdateExclusive | INSERT | no |
| `VALIDATE CONSTRAINT` | ShareUpdateExclusive | ANALYZE | **YES** |

### The safe sequence

| step | lock | ms |
|---|---|---|
| `ADD COLUMN` + `SET DEFAULT` | ACCESS EXCLUSIVE | 4.17 |
| backfill, 1,000-row batches, 10ms pause | ROW EXCLUSIVE per batch | 73,530.14 |
| `ADD CONSTRAINT … NOT VALID` | ACCESS EXCLUSIVE | 1,006.40 |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | 284.52 |

74,840.05ms end to end — **the same work in the same time**, and the longest ACCESS EXCLUSIVE
lock in it was 1,006.40ms rather than 74,722ms.

### Prediction 2 was right, and it makes the card's framing wrong

The card describes the naive migration as "add it NOT NULL with a default". Measured, that is
the *least* damaging shape available:

| naive shape | held | what it leaves |
|---|---|---|
| `backfill` — nullable, `UPDATE`, `SET NOT NULL` | **74,722ms** | correct data |
| `rewrite` — `NOT NULL DEFAULT clock_timestamp()` | **2,827ms** | correct-ish data, heap 552MB → **276MB** |
| `fastwrong` — `NOT NULL DEFAULT now()` | **2.04ms** | **1 distinct value across 2,505,787 rows** |

Since Postgres 11 a **non-volatile** default is evaluated once and stored in
`pg_attribute.attmissingval`, so nothing is rewritten. `now()` is STABLE and qualifies —
which makes `ADD COLUMN … NOT NULL DEFAULT now()` finish in 1.44ms and tell every row in the
table that its last message arrived at the instant of the migration. Fast, silent, and 100%
wrong. A **volatile** default (`clock_timestamp()`) does not qualify, rewrites the whole
table, and takes 2.5s — matching drill 14's 2,563ms for the same shape.

Side effect worth knowing: the rewrite **compacted the heap from 552MB to 276MB**. A table
rewrite is a `VACUUM FULL` you did not ask for.

### The batch size, and what happens at 10x

`pnpm db:schema bench --batches 1000,10000,100000`, 200,000 rows per cell, `VACUUM` between
cells, plan read from `EXPLAIN` on the statement the backfill actually runs:

| scan | batch | rows/s | first batch | last batch | drift | plan |
|---|---|---|---|---|---|---|
| keyset | 1,000 | **134,001** | 21.82ms | 5.87ms | -73% | Nested Loop |
| keyset | 10,000 | 41,791 | 272.59ms | 242.02ms | -11% | Hash Semi Join |
| keyset | 100,000 | 83,044 | 1,193.06ms | 1,215.30ms | +2% | Hash Right Semi Join |
| isnull | 1,000 | 40,725 | 7.14ms | 41.24ms | **+478%** | — |
| isnull | 10,000 | 37,629 | 280.64ms | 255.82ms | -9% | — |
| isnull | 100,000 | 76,161 | 1,299.48ms | 1,326.53ms | +2% | — |

**The batch size chooses the query plan.** At 1,000 rows the planner keeps a Nested Loop
driven by `conversations_pkey`; past that it switches to a hash join whose inner side is a
sequential scan of all 2.5M rows. Isolated `EXPLAIN (ANALYZE)` on the same statement:

```
batch   1,000   Nested Loop  → Index Scan conversations_pkey        15.06ms
batch  10,000   Nested Loop  → Index Scan conversations_pkey        97.19ms
batch 100,000   Hash Semi Join → Seq Scan on conversations (2,505,787 rows)   1,140.18ms
```

So at 10x the chosen batch the page stops being a page: the statement reads the whole table to
find the 10,000 rows it wanted. 10,000 sits exactly on the boundary and the planner does not
choose the same way twice — which is the argument for 1,000 rather than a reason to tune.

Prediction 5 was **wrong**, and in the opposite direction to the one predicted: the knee is
*lower* for this UPDATE than drill 15's 1,000-row INSERT knee, not higher.

Batch 1,000 with a 10ms pause also halves the run: **39,386ms of work against 70,563ms** at
10,000/50ms, while holding each batch's row locks for 6ms instead of 250ms. Both defaults
changed to match.

`SCAN=isnull` is the anti-pattern and it degrades exactly as drill 10's OFFSET does — **+478%
from first batch to last** at 1,000 rows. It is invisible at 100,000 because 200,000 rows is
only two batches; the shape only hurts when there are many, which is when you would use it.

### The finding that changed the shipped migration

`ADD CONSTRAINT … NOT VALID` is a catalog write that should take microseconds. It took
**1,006ms and 1,012ms on two separate runs**, and `pg_locks` says why:

```
pid 3767  ShareUpdateExclusiveLock  granted=true   autovacuum: VACUUM ANALYZE public.conversations
pid 3625  AccessExclusiveLock       granted=false  ALTER TABLE conversations ADD CONSTRAINT …
```

The backfill had just made 2.5M dead tuples, autovacuum started, and the ALTER queued behind
it. Postgres grants locks first come first served, so a *waiting* ACCESS EXCLUSIVE blocks
every conflicting request that arrives after it — the safe path's own garbage nearly bought a
second outage. Migration 016 now sets `lock_timeout = '3s'` around that one statement: fail
the deploy, retry, rather than convert microseconds of DDL into a wait of unknown length.
`VALIDATE` needs no guard, because SHARE UPDATE EXCLUSIVE does not conflict with the locks
reads and writes take.

### The rollback

`pnpm db:schema naive --abort-after 15` cancels the UPDATE mid-flight. The transaction
unwinds correctly — no half-filled column, nothing to reconcile — and still leaves **568,382
dead tuples and the heap up from 275.9MB to 338.5MB**. Fifteen seconds of total outage, every
byte of WAL written, and nothing to show for it.

### The stretch: CREATE INDEX, CONCURRENTLY, and what CONCURRENTLY costs

`pnpm db:schema index` on `(org_id, last_message_at DESC, id DESC)`, 118.6MB either way:

| build | ms | a read took | a write took |
|---|---|---|---|
| `CREATE INDEX` | 683.00 | 2.11ms | **631.44ms** |
| `CREATE INDEX CONCURRENTLY` | 958.09 | 0.62ms | 1.32ms |

SHARE blocks writers and lets readers through, exactly as documented, and here it is the
`pg_locks` line for it:

```
pid 3378  ShareLock         granted=true   CREATE INDEX conversations_org_last_message_idx …
pid 3380  RowExclusiveLock  granted=false  INSERT INTO conversations …
```

The index is **not shipped**: a second 118.6MB copy of drill 09's inbox index, for a column
nothing sorts by.

CONCURRENTLY's two failure modes, both reproduced:

1. **Cancelled mid-build it leaves `indisvalid = false`** — `conversations_org_last_message_idx`
   invisible to the planner and still maintained on every write. A plain build runs in a
   transaction and rolls back to nothing.
2. **It waits for transactions it did not start.** Behind one idle-in-transaction session that
   had INSERTed, the build sat at `wait_event_type=Lock, wait_event=virtualxid, state=active`
   indefinitely, and finished 2,949ms after that transaction committed. The first version of
   this experiment used a read-only idle transaction and the build sailed straight past it —
   a virtual xid is not what it waits for.

### Predictions, and what happened

| # | prediction | outcome |
|---|---|---|
| 1 | naive holds ACCESS EXCLUSIVE 60–150s, 500s from the pool timeout | **right** — 74.7s, 76.73% errors, p50 pinned to the 2s pool timeout |
| 2 | `rewrite` is far shorter, making the card's framing the milder shape | **right** — 2.8s against 74.7s |
| 3 | `fastwrong` under 10ms and ~2.5M rows wrong | **right** — 1.44ms, one distinct value across 2,505,787 rows |
| 4 | safe within 15% of baseline p99 | **right, and better** — 6.09ms against 7.75ms, 21% below |
| 5 | the UPDATE knee is higher than the INSERT's 1,000 | **wrong** — it is lower, and it is a plan flip rather than a slope |
| 6 | `SCAN=isnull` degrades superlinearly, keyset stays flat | **right** — +478% against -73% |

### Two bugs the measurements found

- `EXTRACT(epoch …)` returns **numeric**, which `pg` hands back as a string for the same
  reason it does bigint. The lock report formatted it with `toFixed` and died — after a
  55-second migration it had just finished watching.
- **`http_req_failed`'s `passes` counts the FAILURES.** It is a k6 Rate over "did this request
  fail?", so `fails` is the success count. The first version of the new error line reported a
  clean baseline as "4,500 errors (0.00%)".

And one absence: `handleSummary` **replaces** k6's end-of-test block, so this repo has printed
no error count since drill 05 — "zero errors" was a claim about an exit code. `summary()` now
prints it on every run, including the ~60 already recorded shapes.

## Verification

Stack up first: `COMPOSE_PROJECT_NAME=drills pnpm docker:up`, then `pnpm db:migrate`. The
seeded volume already holds 2.5M conversations; no `db:reset` unless the seed changes force
one.

1. `pnpm db:migrate` — both migrations, timed. Then `pnpm db:schema backfill` once for the
   real column, checked against the oracle: for seeded rows `last_message_at = updated_at`
   for all 2.5M, since the seed builds `updated_at` from the last message.
2. `pnpm db:test` green at the new count. `pnpm db:test:skiplast` red, with the count
   recorded.
3. `pnpm check:arms`, `pnpm arms`, `pnpm check:tenancy`, `pnpm typecheck`.
4. Clean the k6 rows out (`provider_event_id LIKE 'k6-%'`), `VACUUM (ANALYZE) conversations`,
   settle, then three k6 runs in one sitting — cross-sitting deltas under 15% are unproven:
   - `pnpm load write --name baseline`, nothing else running.
   - `pnpm load write --name naive-during`, with `pnpm db:schema naive` fired in a second
     terminal inside the measured window (the `WAIT` knob, so the two launch back to back).
   - `pnpm load write --name safe-during`, with `pnpm db:schema safe`.
5. `pnpm db:schema locks`, `bench`, `index` — recorded runs under `db/reports/`.
6. `pnpm format` and `pnpm lint`.

## Write-up

`drills/16-zero-downtime-migration.md`, one guide, answering the card's three questions with
numbers: which statement took the lock and in which mode, why NOT VALID then VALIDATE avoids
it, and the batch size with what happens at 10x.

## Release

Version 0.16.0, tag `drill/16` on the branch before the merge (the `drill/14` and `drill/15`
precedent), PR opened against `main` and left unmerged, GitHub release created with a
hand-written body.
