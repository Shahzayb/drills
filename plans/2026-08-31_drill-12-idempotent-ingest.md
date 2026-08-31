# Drill 12 — Idempotent webhook ingest, measured under a duplicate storm

Card 12. The drill is not "add a unique constraint" — it is that idempotency is a property of a
*boundary*, that the two mechanisms which look interchangeable fail in different places, and that the
one which looks like the obvious answer (`ON CONFLICT DO NOTHING`) does not answer the concurrent
case at all.

**Status:** planned

---

## Context

Every webhook provider delivers at-least-once. The dangerous case is not the occasional double — it
is an outage recovery draining a retry queue, where thousands of replays land concurrently. An
ingest endpoint that just inserts produces duplicate conversations, duplicate AI spend and duplicate
customer-facing notifications.

This repo has no write endpoint anyone hammers. `POST /ingest` is the first, and it is the first
route where tenant identity is **derived** (from an API key) rather than asserted by the `X-Org-Id`
stub. That makes it the first place drill 07's mechanism has a bootstrapping problem: the lookup that
decides which tenant you are cannot itself run inside a tenant scope.

---

## What ships

**Schema** — three migrations, epoch-ms names monotonically after `1787998200000`.

- `1788134400000_api-keys.js` — `api_keys`, RLS + policy, and the `SECURITY DEFINER` lookup function
  the guard calls.
- `1788134700000_conversations-provider-event-id.js` — `conversations.provider_event_id text`,
  nullable, no default (metadata-only at 2.5M rows).
- `1788135000000_conversations-provider-event-unique-index.js` — the partial unique index,
  `CONCURRENTLY`, in `pgm.noTransaction()`.

**Endpoint** — `POST /ingest`, `Authorization: Bearer <key>`, no `X-Org-Id`. Creates one conversation
and its first message inside `TenantDb.withOrg`. `201 {conversationId, duplicate:false}` on create,
`200 {conversationId, duplicate:true}` on a duplicate.

**Arms** — declared in `docker-compose.yml`, `.env.example` and `/info`'s `arms` block, so
`pnpm check:arms` covers them.

| Switch | Values | Default | Selects |
|---|---|---|---|
| `IDEMPOTENCY` | `none` \| `constraint` \| `redis` \| `both` | `both` | which mechanism guards the write |
| `ON_CONFLICT` | `update` \| `nothing` | `update` | which constraint shape |
| `IDEMPOTENCY_TTL_SECONDS` | integer | `86400` | Redis guard TTL |

**Instruments** — `pnpm db:storm <fire|race|redis-restart|key>` (`apps/backend/db/storm.mts`), and
`pnpm load ingest` (`k6/ingest-storm.ts`) for latency through the repo's warm-up-excluded method.

**Tests** — `test/ingest.e2e-spec.ts`, plus four suite variants: `db:test:constraint` and
`db:test:redis` expected **green** (the card's two approaches, each proven alone), `db:test:noidem`
and `db:test:donothing` expected **red** for different reasons.

**Not built, analysed instead** — the stretch goal (row inserted, side effect not triggered).
Deferred to card 26.

---

## Design decisions

### 1. Authentication is necessarily outside the tenant scope

`api_keys` carries `org_id`, so `pnpm check:tenancy` requires RLS with a policy and a `WITH CHECK` on
it — that check discovers tables by the `org_id` column, so there is no list to update and no way to
opt out. But the guard's lookup runs *before* any org is known: as `app_user` with `app.org_id`
unset, `app_current_org()` is NULL, the policy admits no rows, and the lookup finds nothing.

The hole is punched once, deliberately, and it is exactly one value wide:

```sql
CREATE FUNCTION app_org_for_api_key(hash text) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$ SELECT org_id FROM api_keys WHERE key_hash = hash AND revoked_at IS NULL $$;
```

Owned by `POSTGRES_USER`, so it runs as the owner and RLS exempts it — migration 003 deliberately
does not set `FORCE ROW LEVEL SECURITY`. `EXECUTE` granted to `app_user`, no `SELECT` on the table.
It returns a bigint and nothing else, so the serving role still cannot read the key table.

`SET search_path` is not decoration. A `SECURITY DEFINER` function without a pinned search_path lets
anyone who can create a schema shadow `api_keys` and have the owner read their table instead.

Keys are stored as `sha256` hex in `key_hash`, never in plaintext. `pnpm db:storm key` mints one and
prints it once.

**The eslint escape hatch.** `src/ingest/api-key.guard.ts` imports `PostgresService` directly, which
`no-restricted-imports` in `apps/backend/eslint.config.mjs` blocks. That rule's message says to add
genuinely tenant-free files to its ignores and say why. This is that case, and the reason is the
point of the drill: **this is the code that establishes the tenant, so it cannot run inside one.**

### 2. The unique index is partial, and that is about size, not correctness

```sql
CREATE UNIQUE INDEX CONCURRENTLY conversations_org_provider_event_idx
  ON conversations (org_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
```

`(org_id, provider_event_id)` and not `(provider_event_id)`: two tenants may legitimately send the
same provider event id, and they are different events. Same reasoning as drill 11's
`gin (org_id, tsv)`.

A plain unique index would already be correct — NULLs are distinct in a btree unique index, so the
2.5M seeded rows do not collide with each other. The `WHERE` clause is there so the index holds only
ingested rows instead of 2.5M NULL entries. **The price of the partial predicate:** `ON CONFLICT` must
repeat it in the inference clause, or Postgres cannot match the statement to the index and raises
`42P10`.

### 3. The two `ON CONFLICT` shapes, and what the difference actually is

**Written before measuring:** `DO NOTHING` returns zero rows on conflict, so the id needs a follow-up
`SELECT`, which under a concurrent duplicate cannot see the winner's uncommitted row — so that arm
has to answer 202. `DO UPDATE` takes the row lock, waits, and always answers, at the cost of a dead
tuple per duplicate.

**Both halves of that turned out to be wrong**, and `pnpm db:storm race` is the correction:

- **Both shapes block.** `DO NOTHING` takes the speculative-insertion lock too; it does not skip the
  wait. Measured at ~155ms against a deliberately slow committer.
- **At READ COMMITTED the follow-up `SELECT` finds the row.** Every statement takes a fresh
  snapshot, and `DO NOTHING` has already waited for the winner to commit. The 202 never happens on
  this arm.
- Raise the isolation level and **both shapes fail with 40001** instead — a different problem whose
  fix is retrying the transaction, not choosing a different conflict action.

So the difference is **cost, not correctness**: one round trip against two, and a dead tuple against
none. Ship `DO UPDATE` for the round trip. Keep `nothing` as the arm that prices it.

**One statement, not three:**

```sql
WITH ingested AS (
  INSERT INTO conversations (org_id, status, provider_event_id)
  VALUES ($1::bigint, 'open', $2)
  ON CONFLICT (org_id, provider_event_id) WHERE provider_event_id IS NOT NULL
    DO UPDATE SET provider_event_id = EXCLUDED.provider_event_id
  RETURNING id, xmax = 0 AS created
), first_message AS (
  INSERT INTO messages (conversation_id, org_id, message)
  SELECT id, $1::bigint, $3 FROM ingested WHERE created
)
SELECT id, created FROM ingested
```

`xmax = 0` is the created-vs-duplicate discriminator and it is **an implementation detail, not
documented API**. Drill 08's rule applies: a mechanism nobody would notice breaking needs a test that
fails when it breaks. The e2e case asserting `201 created:true` then `200 created:false` is that test.
Verify it empirically before building on it.

### 4. The Redis guard, and the failure the constraint cannot have

```
SET idem:{orgId}:{eventId} "pending" NX EX <ttl>   -- won? proceed : short-circuit
… insert …
SET idem:{orgId}:{eventId} <conversationId> EX <ttl>
```

A loser reads the value: a real id gives `200 duplicate`, still `"pending"` means the winner has not
committed and gives `202`. On an insert failure the guard is deleted so the event stays retryable.

Four failure modes the constraint version does not have, in order of how much they matter:

1. **The guard is not atomic with the commit, and cannot be made so.** It lives in a different
   system. The compensating `DEL` narrows the window; a process that dies between the `SETNX` and the
   catch **loses the event permanently** until the TTL expires. The constraint cannot lose an event —
   no committed row, no index entry, in one transaction, by construction.
2. **Redis restarting or evicting mid-storm forgets the guard.** Every in-flight duplicate then flows
   to the database. On the `redis` arm alone that is duplicate rows; on `both` it is a latency spike
   and nothing else, which is the argument for `both`.
3. **A duplicate can arrive before the original commits, and Redis has no way to make it wait.**
   Postgres's row lock does exactly that for free on the `DO UPDATE` arm.
4. **It turns an availability dependency into a correctness dependency.** Redis being down used to
   mean a slower `/health`; on the `redis` arm it means wrong data.

**Verdict:** ship the constraint. Redis is a fast path in front of it, never the sole mechanism.
`both` is the default for that reason, and the two pure arms exist to be measured.

**TTL — 86400s, and what that is based on.** On the `redis` arm the TTL is a *correctness* parameter:
it must cover the provider's maximum retry horizon, or a late replay is a duplicate. Providers vary
by orders of magnitude, so the number comes from the provider's documented window, not from taste. On
the `both` arm the guard is only a cache of the constraint's answer, so the TTL is a *cost* parameter
and nothing more. Priced, not guessed:

```bash
redis-cli MEMORY USAGE idem:1:storm-abc-0001   # bytes for one guard key
redis-cli INFO memory                          # used_memory before and after the storm
```

### 5. A storm that shuffles proves nothing

"Duplicates delivered concurrently rather than in sequence" is the whole experiment. Shuffled
randomly, an event's copies land seconds apart and never race. `SHAPE=adjacent` (the default) emits
an event's copies inside one concurrency window; `SHAPE=shuffled` is the control that shows the race
disappearing.

**Verified, not assumed:** Node's global undici dispatcher may cap connections per origin, which
would silently serialise a `Promise.all` of 50 fetches and leave the storm non-concurrent — passing
while testing nothing. The instrument records each request's start and end and reports **max observed
in-flight**; a run where that is not close to `CONCURRENCY` is void. Same class of bug as
`QUERY_COUNTER=off` gating only the reporting.

### 6. Authentication costs one uncached query per request

Every request, including the 7,000 about to be discarded, does a database round trip to
authenticate. So the Redis guard does **not** remove the database from the duplicate path — it
removes the *write* (two inserts and a row lock), which is the expensive half. Caching the key lookup
is the obvious next move and belongs to a caching drill.

`@QueryBudget(3)`: auth + `DO NOTHING` + follow-up select is the worst supported arm.
`IDEMPOTENCY=none` runs 4 and breaches, which is a free extra signal on the red run.

---

## Method

Inherited from drill 05 and not negotiable. Arms **interleaved in one sitting** — this laptop drifts
~4% slower over 90 minutes. Median of rounds, not mean. Nothing under ~15% (20% on the tail) is a
result. Arms are code paths on one commit, never two checkouts. Between arms,
`IDEMPOTENCY=<arm> docker compose up -d nest_server` then `pnpm arms`, because a container older than
the switch is drill 10's lost evening.

Each `db:storm fire` asserts three things and exits 1 on any: rows created `== UNIQUE`, `201` count
`== UNIQUE`, error count `== 0`. It also reports max in-flight, the 202 count, and `n_dead_tup` on
`conversations` before and after.

Cleanup deletes messages then conversations by `provider_event_id = ANY($1::text[])` from ids held in
memory — **not** `LIKE 'prefix%'`, which cannot use the btree index under a non-C collation. It runs
in a `finally` and prints the prefix so a failed run is recoverable by hand.

The storm puts 3,000 rows at the top of the whale's inbox with fresh `updated_at`, which is drill
05/09/10's baseline data. Clean up before measuring anything else.

---

## Predictions, and what happened

Recorded before the runs. Three of six were wrong, and the wrong ones are the drill.

| Predicted | Measured |
|---|---|
| Both arms hold at exactly 3,000 rows from 10,000 concurrent requests | **Yes.** Both, and `both`, and `donothing`. |
| `redis` beats `constraint` on duplicate latency, by less than half | Beats it by **33%** on p50 — and answers 6,994 of 7,000 duplicates with 202 instead of an id. |
| `ON_CONFLICT=nothing` returns 202s under a concurrent storm | **Wrong.** Zero. READ COMMITTED's per-statement snapshot sees the committed row. |
| `DO UPDATE` leaves ~7,000 dead tuples | **Wrong by ~25x.** ~260. The no-op assignment changes no indexed value, so the updates are HOT. |
| `FLUSHDB` mid-storm produces duplicates on `redis` and none on `both` | *(see below)* |
| `IDEMPOTENCY=none` ends at 3,000 rows anyway | **Half right.** Round 2 did; round 1 ended at 1,643 with the server shedding connections. |
| — | Not predicted at all: **`both` is the SLOWEST arm** under an adjacent storm. |

---

## Results

*(filled in after the runs)*
