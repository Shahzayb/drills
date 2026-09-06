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

## Predictions, and what happened

Recorded before the runs. Five of six landed; the one that missed missed by a lot, and the things
nobody predicted are the better half of the drill.

| Predicted | Measured |
|---|---|
| `rmw` loses 20-60% of increments at 100 concurrent | **Wrong, and far worse.** 84% over HTTP through a pool of 10; **99%** in raw SQL at 100 connections. |
| `atomic` is the fastest correct arm and within noise of `rmw` | **Yes.** 546 vs 529 req/s over HTTP, 1,246 vs 1,252 in SQL — and under sustained k6 load `atomic` is *faster* than the broken arm. |
| `locking` costs measurably more than `atomic` | **Yes, but small.** -7% throughput over HTTP and in SQL, -12% under k6. |
| `serializable` retries >1/request and wrecks p99; may exhaust the cap | **Yes.** 1.93 retries/request, p99 295ms against `atomic`'s 174ms, and 1 of 100 still 503s at a cap of 20. |
| REPEATABLE READ already fixes the lost update | **Yes, and stronger than predicted** — at RR and SERIALIZABLE *every* shape aborts, including `used = used + 1`. |
| Stretch: only SERIALIZABLE and a widened lock hold | **Yes, all three parts.** |
| — | Not predicted: **the retry rate is a property of transaction LENGTH, not of concurrency.** Same 100 writers, 10x the retries. |
| — | Not predicted: **`QUOTA_MAX_RETRIES` buys probability, not certainty**, and the mean retry rate describes nobody. |

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

Postgres 18, `shared_buffers=128MB`, whale org 1 (2.5M conversations, 10M messages), pool `max: 10`,
`max_connections=200` for `bench` only. Arms interleaved, medians of the rounds. Every table below
cites the report directory that produced it, under `apps/backend/db/reports/`.

### The card's DONE WHEN

**The test fails on the original at 100 concurrent and passes on all three fixes.**

| command | arm | result |
|---|---|---|
| `pnpm db:quota fire` | `QUOTA=rmw` | **exit 1**, counter 13-18 of 100, 6 runs out of 6 |
| `pnpm db:quota fire` | `atomic`, `locking` | exit 0, counter 100 |
| `pnpm db:test:rmw` | `QUOTA=rmw` | **red x2**, 10 runs out of 10 |
| `pnpm db:test:locking` | `QUOTA=locking` | green, 3 of 3 |
| `pnpm db:test:serializable` | `QUOTA=serializable` | green, 10 of 10 |

Suite 100 -> **106**, all green on the default arm.

### `pnpm db:quota race` — the deterministic reproduction

Two sessions, an interleaving this file chooses, no luck involved.

```
  A  SELECT used            -> 99
  B  SELECT used            -> 99
  A  UPDATE used = 100
  A  COMMIT
  B  UPDATE used = 100
  B  COMMIT

  counter = 100. Two deliveries, one billed.
```

Then the same interleaving at three isolation levels (`…-final-quota-race-org1`):

| shape | READ COMMITTED | REPEATABLE READ | SERIALIZABLE |
|---|---|---|---|
| read-modify-write | **100 — lost** | 40001 | 40001 |
| `SELECT … FOR UPDATE` | 101 | 40001 | 40001 |
| `used = used + 1` | 101 | 40001 | 40001 |

Two things fall out of that table and neither is obvious.

**READ COMMITTED is not broken.** It guarantees you never read uncommitted data, and it delivered
that: both sessions read 99, which was committed. It says nothing about a value going stale between
your `SELECT` and your `UPDATE`, and the lost update lives in exactly that gap.

**Raising the isolation level makes the atomic fix stop being free.** At READ COMMITTED
`used = used + 1` blocks, re-reads the committed row, and composes. At REPEATABLE READ the same
statement raises 40001 instead — first-updater-wins. So "just use `used = used + 1`" is advice that
depends on the isolation level nobody mentioned, and a codebase that raises its default later breaks
every counter in it at once.

### `pnpm db:quota fire` — 100 concurrent deliveries through the endpoint

Medians of 3 interleaved rounds (`…-final-<arm>-r{1,2,3}-quota-fire-org1`). Every event id distinct,
so every delivery is billable and all 100 contend on one counter row.

| arm | counter | lost | retries/req | 503 | req/s | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| `rmw` | **16** | **84** | 0 | 0 | 529 | 152.01 | 179.15 | 180.17 |
| `atomic` | 100 | 0 | 0 | 0 | **546** | **149.93** | **173.10** | **174.36** |
| `locking` | 100 | 0 | 0 | 0 | 508 | 155.74 | 186.63 | 188.84 |
| `serializable` | 99 | 0 | 1.93 | **1** | 332 | 214.65 | 277.19 | 295.40 |

**84 of 100 billable events never reached the meter, and every request returned 201.** The ledger says
100 and the counter says 16; nothing anywhere reported a problem.

**`rmw` is not faster.** It is within noise of `atomic` here and slower under sustained load. The bug
buys nothing at all — it is not a trade, it is just wrong.

**`serializable` never loses an update and refuses work instead.** Its counter always equals its
ledger, because the ledger row and the increment are in the same transaction: a 503'd delivery writes
neither. It converts a silent correctness failure into a loud availability one, which is a much better
failure and still a failure.

### The retry budget is not a detail of the fix, it is the fix

`QUOTA_MAX_RETRIES` swept at 100 concurrent (`…-ser-max{5,20,100}-quota-fire-org1`):

| cap | counter | 503 | retries/req | p99 |
|---|---|---|---|---|
| 5 | **65** | **35** | 2.51 | 276.95 |
| 20 | 100 | 0 | 2.01 | 296.81 |
| 100 | 100 | 0 | 1.82 | 291.34 |

At a cap of 5 the SERIALIZABLE arm sheds a third of the traffic. The default is **20** on that
evidence — and 20 is measured for *this* contention, not a universal number.

**It buys probability, not certainty.** Even at 20, one delivery in a hundred still exhausts the cap.
On a single hot row there is no cap that guarantees success, only one that trades error rate for tail
latency.

### The mean retry rate describes nobody

From the container's own logs during one 100-request burst, no instrument involved:

```bash
docker compose logs nest_server --since <t> --no-color | grep -o '"retries":[0-9]*' \
  | awk -F: '{print $2}' | sort -n | uniq -c
```

```
  74 requests   0 retries
   2 requests   1        3 requests   2        1 request    3
   5 requests   4        3 requests   6        3 requests   9
   1 request   10        1 request   12        1 request   13
   2 requests  15        1 request   16        2 requests  18
   1 request   20   <- hit the cap, 503
```

213 retries over 100 requests. **74% of requests retry zero times and the unlucky quarter retries a
median of 6, up to the cap.** "1.93 retries per request" is a number no request experienced. The log
sum matches the instrument's header count exactly, which is also the answer to "how would you measure
this in production without building anything".

### `pnpm db:quota bench` — the mechanism with the endpoint removed

100 increments at concurrency 100, raw SQL, one connection per transaction, 3 interleaved rounds
(`…-final-quota-bench-org1`):

| arm | counter | lost | retries/req | req/s | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| `rmw` | **1** | **99** | 0 | 1,252 | 25.99 | 49.17 | 52.66 |
| `atomic` | 100 | 0 | 0 | 1,246 | 24.59 | 42.71 | 47.20 |
| `locking` | 100 | 0 | 0 | 1,153 | 29.27 | 49.91 | 55.35 |
| `serializable` | 100 | 0 | **0.20** | 405 | 93.16 | 174.29 | 209.35 |

**The finding is the retry rate, and it is a 10x gap against the endpoint's 1.93.** Same 100 writers,
same one row, same SQL. What changed is how long each transaction is held: the endpoint's transaction
does an auth lookup, an upsert with two CTEs and the counter, over HTTP, through a pool of ten. The
bare mechanism does two statements on a dedicated connection.

**So the retry rate is a property of transaction length, not of concurrency.** The lever on a
SERIALIZABLE retry storm is a shorter transaction, and that is not where anyone looks first.

At 100 connections the raw `rmw` arm loses **99 of 100** — every writer reads the same value.

### `pnpm load ingest` — sustained, 100 VUs, 15s warm-up discarded, 30s measured

| arm | p50 | p95 | p99 | throughput |
|---|---|---|---|---|
| `atomic` | **49.19** | **58.61** | **66.21** | **2,000 req/s** |
| `rmw` | 51.07 | 62.50 | 73.98 | 1,907 req/s |
| `locking` | 55.01 | 70.84 | 82.88 | 1,754 req/s |
| `serializable` | 104.27 | 211.25 | 260.67 | 871 req/s |

**SERIALIZABLE costs 3.9x the p99 and 56% of the throughput.** `locking` costs 25% of p99 and 12% of
throughput. And the broken arm is *slower than the correct one* — 1,907 against 2,000 — which removes
the last argument anybody has for it.

Reproduce with `--unique 100000000` so every request is a new event. k6 has no database connection and
no cleanup; delete its rows before any drill 05/09/10 baseline:

```sql
DELETE FROM conversations
 WHERE org_id = 1 AND provider_event_id IS NOT NULL AND provider_event_id LIKE 'k6-%';
```

`provider_event_id IS NOT NULL` is not redundant — it is what lets the partial unique index answer
this instead of sequential-scanning 2.5M rows.

### Stretch — `pnpm db:quota skew`, a second counter under one budget

`events.used + messages.used <= quota_limit`, two metric **rows**, one shared cap of 100. `events`
starts at 99, so exactly one of the two concurrent increments may legally happen
(`…-final-quota-skew-org1`):

| fix | isolation | A | B | total | holds |
|---|---|---|---|---|---|
| atomic `UPDATE` with a `sum()` guard | READ COMMITTED | ok | ok | **101** | **no** |
| `FOR UPDATE` on the row it writes | READ COMMITTED | ok | ok | **101** | **no** |
| `FOR UPDATE` on every row it reads | READ COMMITTED | ok | ok | 100 | yes |
| SERIALIZABLE | SERIALIZABLE | ok | 40001 | 100 | yes |

**Only one of the three fixes survives unchanged, and it is the slowest one.**

- **Atomic `UPDATE` cannot express this.** It is one statement over one row; the guard has to read the
  *other* row, and a subquery reads it from this statement's snapshot, where the concurrent increment
  does not exist yet. There is no version of "do the arithmetic in SQL" that fixes a cross-row
  invariant.
- **`FOR UPDATE` holds only when it is widened.** Locking the row you write is the obvious reading and
  it protects nothing here — the two transactions lock different rows and never meet. The rule is
  **lock everything you read**, not everything you write, and it has to be `ORDER BY` a stable key or
  two transactions take the same locks in different orders and deadlock.
- **SERIALIZABLE holds with no change at all.** The read-then-write that was wrong under the row lock
  is correct under SSI, because the anomaly is a rw-dependency and SSI is looking for exactly that.

This is write skew, not a lost update, and the difference matters: a lost update is two writers on one
row, write skew is two writers on different rows breaking a rule that spans them. The first three fixes
are about rows. Only the last one is about the rule.

---

## Verdict — what shipped and what would change it

**`atomic` is the default.** It is the fastest arm in every measurement including the broken one, it
is one statement, it needs no retry loop, no lock ordering and no 503 path, and it removes the bug
completely at the isolation level this stack already runs.

**What would change my mind, in order of likelihood:**

1. **A second counter with an invariant across rows.** Measured above: `atomic` does not merely get
   slower, it stops being expressible. That is the day this becomes SERIALIZABLE plus retry, and the
   price is the k6 table — 3.9x p99, 44% of the throughput.
2. **Anyone raising the default isolation level.** At REPEATABLE READ `used = used + 1` starts raising
   40001, so `atomic` silently acquires a retry requirement it does not have today. `db:quota race`
   is the test that catches it.
3. **A counter the application has to see before it writes** — a quota that rejects at the limit, say.
   `atomic` returns the new value, so a `WHERE used < quota_limit` predicate still works on one row;
   anything needing the value *before* deciding is back to a read, and then it is `locking`.
4. **Contention high enough that the row lock is the bottleneck.** Not reached here: 2,000 req/s
   through one row. The fix then is not a different mechanism, it is a different shape — sharded
   counter rows summed on read, or dropping the counter and aggregating the ledger.

**The honest framing:** the counter is a cache of `count(usage_events)`, and none of this is a problem
the ledger has. The best version of this endpoint may not keep a counter at all.

---

## Revised while shipping

- **The ledger's FK had to become `ON DELETE SET NULL`.** `usage_events.conversation_id NOT NULL
  REFERENCES conversations` made `DELETE /conversations/:id` fail with a foreign key violation for
  every conversation that arrived through ingest, and broke drill 12's e2e teardown. The fix is also
  the correct billing semantics: a ledger row records that the org was billed, so deleting the
  conversation must not unbill it. `CASCADE` would have been the wrong answer for the same reason.
- **The measured retry rate was wrong by 5x, and the bug was in the instrument.** It read `retries`
  from the response body — and a 503 from an exhausted retry loop carries Nest's error body, which has
  no such field. So the requests that retried *hardest* were the only ones excluded from the average.
  It read 0.50/request; the truth was 2.51. Fixed with an `x-txn-retries` response header, set on the
  error path too. Same class as drill 08's `QUERY_COUNTER=off`: a measurement that quietly omits its
  own subject.
- **`max_connections` became a knob.** `bench` opens one connection per concurrent transaction, and at
  100 there is no headroom over Postgres' default of 100 — it died with `53300` from inside pg's
  connect path, which never names the setting. `PG_MAX_CONNECTIONS` follows `PG_PRELOAD`'s pattern:
  default unchanged, so no recorded baseline moves. The instrument now checks headroom and refuses,
  because the alternative failure is worse — a pool that quietly serialised would report an `rmw` arm
  with no lost updates at all.
