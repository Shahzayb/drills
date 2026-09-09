# Drill 16 — Add a required column to 2.5M rows without taking the site down

**Status:** planned

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

To be filled in after the measurements land.

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
