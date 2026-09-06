# Drill 13 — Lose an update on purpose, then fix it three ways

Card 13. The drill is not "add `used = used + 1`" — it is that **step one is harder than the fix**.
A lost update is invisible: two 201s, no error, no log line, and a counter that is quietly short. The
card's real question is the interview one — *what isolation level are you on, and what does it
actually protect you from?*

**Status:** shipped

---

## Context

Every org has a monthly quota. The meter reads the count, adds one in application code, writes it
back. At low traffic it is fine. Under a burst from the whale org's integration two requests read 99
and both write 100: one billable event delivered, one billed. At 200 events a second on your biggest
customer that is constant and invisible, and you eat the overage.

Drill 12 built the victim. `POST /ingest` is the only write endpoint anyone hammers, and
`pnpm db:storm fire` already fires 10,000 concurrent deliveries at it. Hanging a counter off that
path puts the bug on a route that already has a working concurrency harness in front of it.

It also inherits drill 12's property, which turns out to be load-bearing: **retry-on-40001 is only
safe because the write is idempotent.** A `SERIALIZABLE` retry re-runs the whole transaction,
conversation insert included. Without `ON CONFLICT` that retry would be a second row.

---

## What ships

**Schema** — one migration, `1788739200000_usage-events-and-quota-counters.js`. Hand-written SQL in
`pgm.sql()`, same as every migration here.

- `usage_events` — the append-only ledger. One row per billable event.
- `usage_counters` — `(org_id, period, metric)` primary key, `used`, `quota_limit`. The
  denormalisation, and where the bug lives.

Both carry `org_id`, so `pnpm check:tenancy` requires RLS + a policy + `WITH CHECK` + grants on both.
Both are added to `db/seed.mts`'s `TRUNCATE` list, or the seed dies with `0A000`.

**Endpoint** — `POST /ingest` gains two things inside the transaction it already had: a
`usage_events` row folded into the existing CTE (gated `WHERE created`, so a duplicate delivery does
not bill twice), and a counter increment whose mechanism is the arm.

**Arms**

| Switch | Values | Default | Selects |
|---|---|---|---|
| `QUOTA` | `rmw` \| `atomic` \| `locking` \| `serializable` | `atomic` | how the counter is incremented |
| `QUOTA_MAX_RETRIES` | integer | `5` | serialization-failure retries before 503 |

**Instrument** — `pnpm db:quota <fire|bench|race|skew>` (`apps/backend/db/quota.mts`).

**k6** — no new script. `k6/ingest-storm.ts` with `--unique` large enough that every request is a new
event, so every request increments.

**Tests** — `test/quota.e2e-spec.ts`, plus `db:test:rmw` (expected **red**), `db:test:locking` and
`db:test:serializable` (expected **green**).

---

## Design decisions

### 1. Two tables, because the ledger is the oracle

`usage_events` is append-only. An `INSERT` has no read-modify-write, so it cannot lose an update.
That is what makes `count(usage_events)` the thing that *proves* the counter wrong:

```sql
SELECT c.used, (SELECT count(*) FROM usage_events e
                 WHERE e.org_id = c.org_id AND e.period = c.period AND e.metric = c.metric) AS ledger
  FROM usage_counters c WHERE …;
```

`used = 87` against a ledger of `100` is thirteen lost updates, measured rather than argued. Without
the ledger the only oracle is "how many requests did I send", which lives in the test process and
dies with it.

The deeper point, and the honest one: **the counter is a cache of a `count(*)`.** Every problem in
this drill is a consequence of denormalising, and "do not keep the counter" is a real option that the
write-up has to price rather than skip past.

### 2. `metric` is a column, and that is for the stretch

`usage_counters` is keyed `(org_id, period, metric)`, so two metrics are two **rows**. Two columns in
one row would make every cross-metric invariant trivially atomic — one row, one `UPDATE`, done — and
delete the stretch experiment. The invariant the stretch tests is across rows on purpose.

The shipped endpoint only ever touches `metric = 'events'`. `'messages'` exists for `db:quota skew`.
That is over-building of exactly one column, recorded here so a later pass does not "simplify" it.

### 3. The four arms differ by a handful of characters

```sql
-- rmw           the bug. Two statements, and a gap between them.
SELECT used FROM usage_counters WHERE org_id=$1 AND period=$2 AND metric=$3;
UPDATE usage_counters SET used = $4, updated_at = now() WHERE org_id=$1 AND period=$2 AND metric=$3;

-- atomic        one statement. Postgres does the arithmetic, under its own row lock.
INSERT INTO usage_counters (org_id, period, metric, used) VALUES ($1,$2,$3,1)
  ON CONFLICT (org_id, period, metric)
  DO UPDATE SET used = usage_counters.used + 1, updated_at = now()
  RETURNING used;

-- locking       rmw plus two words. Same arithmetic, in the application, and correct anyway.
SELECT used FROM usage_counters WHERE … FOR UPDATE;
UPDATE usage_counters SET used = $4 …;

-- serializable  rmw, byte for byte, inside BEGIN ISOLATION LEVEL SERIALIZABLE + retry on 40001.
```

**The cold path is atomic on every arm.** When the `SELECT` finds no row — the first event of a
period — every arm falls back to the upsert above. Creating the row is not the read-modify-write
being demonstrated; there is nothing to read yet. One extra statement, once per org per month.

### 4. `TenantDb.withOrg` is extended, not wrapped

```ts
withOrg<T>(orgId, fn, options?: { isolation?: 'SERIALIZABLE'; retries?: number }): Promise<T>
```

`BEGIN ISOLATION LEVEL SERIALIZABLE` in place of `BEGIN`, and a retry loop inside `withClient`:
`ROLLBACK`, back off, `BEGIN` again on the same pinned client. Retried on SQLSTATE `40001`
(serialization failure) and `40P01` (deadlock). Backoff is jittered — a hundred retriers with no
backoff is a thundering herd, and the herd is a separate measurement rather than a default.

Retries exhausted raises `ServiceUnavailableException` (503). Not a 500: "come back later" is the
honest answer, and it keeps the instrument's `5xx == 0` assertion meaningful.

Counted through `recordRetry()` in the existing `observability/request-context.ts`, beside
`recordQuery`/`recordRoundTrip`, and surfaced on `IngestResult.retries`.

### 5. `@QueryBudget` goes 3 -> 4, and a retry breaching it is correct

Shipped default (`both` + `atomic`) is 3: auth, the upsert CTE, the counter. `ON_CONFLICT=nothing`
adds the follow-up select. `rmw`/`locking` are 4. `nothing` + `rmw` is 5 and breaches, the same way
`IDEMPOTENCY=none` already does.

**A retried `serializable` request also breaches, and that is not a bug.** It genuinely made those
round trips. The budget becomes a second, independent readout of the retry rate — one that nobody had
to build.

### 6. A deliberate stall between the SELECT and the UPDATE was rejected

A `QUOTA_STALL_MS` sleep would make the red run reproduce 100% of the time. It would also prove that
the code sleeps, not that it races. The deterministic proof is `db:quota race`, which *controls* the
interleaving with two live sessions instead of widening the window and hoping.

So there are two reproductions, and they answer different questions: `race` cannot flake and shows
the mechanism; `fire` and the e2e spec are statistical and show that it happens under ordinary load.

---

## Predictions, recorded before measuring

1. `rmw` loses 20-60% of increments at 100 concurrent through a pool of 10.
2. `atomic` is the fastest correct arm and within noise of `rmw`.
3. `locking` costs measurably more than `atomic` — an extra round trip while holding a row lock.
4. `serializable` retry rate at 100 concurrent on **one hot row** is above 1 retry per request and
   wrecks p99, because every retry re-conflicts. It may exhaust `QUOTA_MAX_RETRIES` and 503.
5. **REPEATABLE READ already fixes the lost update** — first-updater-wins raises 40001 — so
   SERIALIZABLE is not what buys this. It is what buys the stretch.
6. Stretch: `atomic` cannot express the cross-row invariant at all; `locking` holds **only** if it
   locks every row it *reads*, not just the one it writes; `serializable` holds for free.

---

## Method

Inherited from drill 05 and not negotiable. Arms interleaved in one sitting — this laptop drifts ~4%
slower over 90 minutes. Medians, not means. Nothing under ~15% is a result. Arms are code paths on
one commit, never two checkouts. Between arms, `QUOTA=<arm> docker compose up -d nest_server` and then
`pnpm arms`, because a container older than the switch is drill 10's lost evening.

`db:quota fire` writes real rows at the top of the whale's inbox and cleans up after itself by
`provider_event_id = ANY($1::text[])` from ids held in memory. A `pnpm load ingest` run does not —
delete `k6-` prefixed rows before any drill 05/09/10 baseline.

---

## Results

*(filled in after the sweep)*
