# Drill 08 — Count the queries you didn't know you were making

**Status:** shipped

Plan file lands at `plans/2026-08-17_drill-08-n-plus-one.md` on approval, with a `planned` row
appended to `memory-bank/history.md` before any code.

## Context

`GET /conversations` returns `assigneeId` — a bigint the reader cannot use — and no tags at all.
The obvious feature request is one line of template: show the assignee's *name*, and show tag chips.
The obvious implementation is a lookup per row inside the map, and with an ORM you would write it
without noticing. Writing raw SQL, the loop is visible, which is what makes this card worth doing:
the exercise is not "what is an N+1", it is **"would my instrumentation have found one I did not
already know about?"**

Two properties of this repo make the honest version of that question available:

- **Drill 06 already puts `/* rid=… */` inside every statement.** Postgres's own log can therefore
  count one request's round trips with no application instrumentation at all — a second detection
  method that exists for free, and one an ORM could not defeat.
- **Drill 07 pinned one connection per request** (`withOrg` → `BEGIN` … `COMMIT`). So the card's
  scenario — "saturates the connection pool while every query looks fast" — is **not** the shape the
  N+1 takes here. It takes the shape of a connection held five times longer. That difference is a
  finding to state, not a detail to skip.

Deliverable: the feature, a per-request query counter with a declared budget, both numbers, and a
recorded answer to which detection method would have caught it first.

## Decisions taken before planning closed

| decision | why |
|---|---|
| The naive path **stays**, behind `LIST_STRATEGY=naive\|batched` (default `batched`) | Drill 07's rule: arms must differ only in the variable, not in whether the process restarted. Both arms are one commit and one `docker compose up -d nest_server`. It is also the violator the stretch's budget test needs to prove itself red. |
| `pg_stat_statements` is **off by default**, behind `PG_PRELOAD` | `shared_preload_libraries` is postmaster-context. The repo's recorded rule is that new instrumentation ships off, because an always-on instrument silently changes the baseline every later A/B depends on. |
| Fix = **LEFT JOIN for the assignee + one batched query for tags** (3 statements) | Hits the card's ≤3. The `LATERAL json_agg` alternative (2 statements) gets an `EXPLAIN (ANALYZE, BUFFERS)` comparison, not a k6 arm. |
| Three cleanups ride along | `progress.md`'s card-08 prediction, the `nest new` scaffolding, the `main.ts` floating promise. Listed in phase 8. |

## Phase 0 — environment

Worktree Compose project name differs from the seeded volume's. Copy `.env` from the main worktree
and add `COMPOSE_PROJECT_NAME=drills` so `drills_drills_pgdata` is reused — same 2.5M rows every
earlier number was measured against. Then `pnpm docker:up`, `pnpm db:migrate:status`.

`VACUUM (ANALYZE)` before **any** measurement. Drill 04: `ANALYZE` alone leaves `count(*)` a seq
scan and moves the whale by 2x.

## Phase 1 — schema and seed for tags

### Migration `1786964400000_tags-and-conversation-tags.js`

Hand-written SQL inside `pgm.sql()`, per drill 02's rule.

```sql
CREATE TABLE tags (
  id bigserial PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES organizations (id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_org_id_name_key UNIQUE (org_id, name)
);

CREATE TABLE conversation_tags (
  conversation_id uuid   NOT NULL REFERENCES conversations (id),
  tag_id          bigint NOT NULL REFERENCES tags (id),
  org_id          bigint NOT NULL REFERENCES organizations (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, tag_id)
);
```

Four deliberate choices, each with a comment in the file:

- **`org_id` on the join table too.** Drill 02's load-bearing rule — every tenant-owned row carries
  it directly — is what lets drill 07's policy find the tenant without a join. A join table is
  exactly where people skip it.
- **`UNIQUE (org_id, name)` is the org index.** Leftmost prefix answers "this org's tags"; no
  separate `org_id` index, same reasoning as `memberships` in migration 001.
- **No index on `conversation_tags.tag_id`.** Nothing reads "conversations with tag X" yet; card 11
  (search) is where that changes. A deliberate gap, recorded, in drill 02's habit.
- **No `updated_at` on `conversation_tags`.** A membership row is created and deleted, never
  updated. Deviating from the convention on purpose is worth one line of comment.

Then, because migration 003 deliberately declined `ALTER DEFAULT PRIVILEGES`, this migration must do
what that decision predicted: **explicit `GRANT`s and explicit policies for both new tables.**

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON tags, conversation_tags TO <app_user>;
GRANT USAGE, SELECT ON SEQUENCE tags_id_seq TO <app_user>;
ALTER TABLE … ENABLE ROW LEVEL SECURITY;
CREATE POLICY …_tenant_isolation ON … FOR ALL TO PUBLIC
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
```

`pnpm check:tenancy` is the backstop and must pass with five tables listed, not three. `down`
reverses in dependency order.

### Seed (`apps/backend/db/seed.mjs`)

Follows the existing structure exactly — plan, generate, stream, and one deterministic RNG stream
per table (`SEED + 6`, `SEED + 8` for the two new ones, so the existing streams do not shift and
drill 04's five recorded table hashes stay valid).

- **Vocabulary**: 16 fixed tag names (`bug`, `billing`, `feature-request`, `urgent`, `churn-risk`,
  `onboarding`, `integration`, `performance`, `refund`, `docs`, `mobile`, `api`, `security`, `ux`,
  `enterprise`, `follow-up`). Fixed rather than faker, so a tag chip is legible in a screenshot and
  the same tag means the same thing across runs.
- **Per org**: contiguous id blocks (`tagStart[org]` / `tagCount[org]`), same trick memberships use
  so picking a tag is a range index rather than a lookup. Whale 12, orgs 2–10 nine, the rest 4–6.
- **Per conversation**: exact buckets in drill 04's floor-plus-residue style —
  `TAG_BUCKETS = [{0, .18}, {1, .42}, {2, .28}, {3, .12}]`, mean 1.34, ≈3.35M
  `conversation_tags` rows at scale 1. Drawn without replacement inside the org's block so the PK
  cannot collide. `created_at` = the conversation's.
- **Load**: `conversation_tags` streams through `copyInto` like messages; `tags` is small enough to
  build as one string. Both added to the `TRUNCATE` list; `tags_id_seq` gets a `setval`.
- **The FK lever applies again.** `conversation_tags_conversation_id_fkey` is 3.35M per-row trigger
  firings against a 2.5M-row uuid index — drill 04's single biggest lever (51.6s on messages),
  repeating. Drop before load, re-add `NOT VALID` + `VALIDATE`.
- **The PK index is kept.** Dropping it means dropping and re-adding a constraint, which is more
  seed machinery. Measure the seed first; only add that lever if total exceeds ~150s against the
  6-minute budget, and record the number either way.

`db:seed:ci` at `--scale=0.1` must still work — orgs and tags do not scale, only conversations.

## Phase 2 — the feature, written the naive way on purpose

### API shape

`ConversationListItem` gains two fields; `assigneeId` stays (removing it would be an unrelated
breaking change):

```ts
assigneeName: string | null;
tags: { id: string; name: string }[];
```

`GET /conversations/:id` is **not** changed. The card is about the list, and the tenant-isolation
suite pins that route's behaviour.

### `ConversationsService.list()` — the naive path

Selected by `LIST_STRATEGY=naive`, read once at module load. Inside the same `withOrg` transaction,
after the list and count queries, a loop over the rows:

```sql
-- once per row with an assignee
SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1

-- once per row, always
SELECT t.id, t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
 WHERE ct.conversation_id = $1 ORDER BY t.name
```

Sequential `await`s in a `for` loop, not `Promise.all` — the naive version is naive, and on a pinned
client `pg` would queue them anyway.

Expected counts: **`pageSize=50` → 1 + 1 + ~40 + 50 ≈ 92 statements** (the card's "101" is
1 + 50 + 50 with every row assigned); **`pageSize=20` → ≈ 38**, which is what k6 measures, because
drill 05's baseline URL is `?page=1&pageSize=20` and changing it invalidates every recorded run.

### Frontend

`lib/api.ts`'s `Conversation` gains the two fields. `app/conversations/page.tsx` shows the assignee
name (falling back to `—`) instead of the raw id, and a tags column of chips — still zero client
JavaScript, still plain `<a>` links.

## Phase 3 — the counter, and a budget

### Counting

`RequestContext` (`src/observability/request-context.ts`) gains two mutable counters and a
`getRequestContext()` accessor. `PostgresService.runOn()` increments `queries`;
`ClientHandle.control()` increments `roundTrips` only.

**Two counters, not one, and that is the point.** `queries` is what the card's "≤3" is about.
`roundTrips` includes `BEGIN` / `set_config` / `COMMIT` — three more trips per request that drill 07
measured at ~0.94 ms and that no ORM's query log would show you. A budget on `queries` alone would
quietly under-report the real number.

### Reporting

`LoggingInterceptor` currently bails before building the `tap()` chain unless `debug` is enabled —
drill 06 measured that guard at ~5–6% of tail throughput. That has to change, because a budget check
must run at `info`. New shape:

- `debug`: the existing `handler` line gains `queries` and `roundTrips`.
- **`warn`, at any level: `query_budget_exceeded`** with `rid`, `ctrl`, `handler`, `orgId`,
  `queries`, `budget`. Same design as `slow_query` — a threshold event survives the default level,
  which is the entire reason a threshold exists. This is the line that would page you.
- The response header `x-query-count` is set only in `header` mode (below).

`QUERY_COUNTER=off | on | header`, default `on`, read at module load:

- `off` — no counting, no tap: drill 06's exact code path, and therefore a real measurement arm for
  what the counter itself costs.
- `on` — count, and warn past budget.
- `header` — also set `x-query-count`. Off in production because a response header is API surface;
  `apps/backend/package.json`'s `test:e2e` script sets it, so the e2e suite always has it.

### The budget

`@QueryBudget(n)` — `SetMetadata`, read by the interceptor through `Reflector.getAllAndOverride`
(handler then class). `DEFAULT_QUERY_BUDGET = 5` applies to every route that declares nothing, which
is what makes this catch **the N+1 nobody annotated**. `list` declares `@QueryBudget(3)`.

## Phase 4 — the detection exercise, before the fix

Done with the naive path running, in this order, and the point is to work from the instrument rather
than from memory.

1. **`pg_stat_statements`.** `docker-compose.yml`'s `command:` gains
   `-c shared_preload_libraries=${PG_PRELOAD:-}`, empty by default. Turn it on with
   `PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db`, then three new root scripts in
   the `db:log:*` house style: `db:stats:on` (`CREATE EXTENSION IF NOT EXISTS`, with a legible error
   when the library is not preloaded), `db:stats` (top statements by `calls` and by
   `total_exec_time`), `db:stats:reset` — all three one `db/stats.mjs` taking a subcommand, not psql
   one-liners: two orderings and a `dealloc` read do not survive three layers of shell quoting,
   which is precisely what killed drill 07's `rls:status`.

   Two things to verify rather than assume: that Postgres accepts an **empty**
   `-c shared_preload_libraries=` (the default *is* the empty list, so it should — but a server that
   refuses to start is a broken `pnpm docker:up` for everyone), and that `db:stats:on` fails loudly
   rather than silently when `PG_PRELOAD` was forgotten.

   The extension is created by a script and **not** by a migration: a migration that fails whenever
   the library is not preloaded would break `pnpm db:migrate` for everyone, and `db:reset`'s
   `DROP SCHEMA public CASCADE` would take it anyway.

   **Check rather than assume — this is a real risk, not a formality.** Drill 06 appends
   `/* rid=… */` to every statement. `pg_stat_statements` derives `queryid` from the post-parse
   tree, so comments *should* normalise away and the 50 per-row lookups *should* collapse into one
   row with `calls = 50`. If they do not, every request mints its own entry, `pg_stat_statements.max`
   (5000) blows out, `pg_stat_statements_info.dealloc` climbs, and the instrument is destroyed by
   our own drill-06 comment — which would be the finding of the night and would mean the comment
   stands down when stats are on, exactly as it already does when tracing is on. Either way, record
   the observed `calls`, the `dealloc` counter, and whether the stored query text carries a stale
   `rid`.

2. **The statement log.** `pnpm db:log:on`, load one page, then
   `docker compose logs postgres_db | grep -c 'rid=<id>'` — one request's round trip count straight
   out of Postgres, with zero application instrumentation. `pnpm db:log:off` afterwards, and
   `db:log:status` to prove it, because `ALTER SYSTEM` survives `docker compose down`.

3. **The counter**, last, so it confirms rather than leads.

Record for each: what it shows, what it *cannot* show, and how long it took to get to the answer.
The three writeup questions are answered from this section, in particular the ORM one — the counter
and the Postgres log both keep working when nobody wrote a loop; only "I remember writing that
loop" does not.

## Phase 5 — the fix

`LIST_STRATEGY=batched`, the default. Three statements.

```sql
-- 1. list, with the 1:1 assignee joined in
SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
       c.created_at, c.updated_at
  FROM conversations c
  LEFT JOIN memberships m ON m.id = c.assignee_id
  LEFT JOIN users u       ON u.id = m.user_id
 WHERE c.org_id = $1
 ORDER BY c.<sort> DESC, c.id DESC
 LIMIT $2 OFFSET $3
```

**Every column is qualified, and that is load-bearing**: `users` also has `updated_at` and
`created_at`, so an unqualified `ORDER BY updated_at` is ambiguous — at best an error, at worst a
silent sort by the wrong table.

```sql
-- 2. count, unchanged (card 08 is not the count(*) card)
-- 3. tags for the whole page, one round trip
SELECT ct.conversation_id, t.id, t.name
  FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
 WHERE ct.conversation_id = ANY($1::uuid[])
 ORDER BY ct.conversation_id, t.name
```

Grouped into a `Map<conversationId, tag[]>` in JS. **Skipped entirely when the page is empty**, so an
empty page is 2 statements, not 3.

LEFT JOIN, not INNER: 20% of conversations are unassigned by seed design, and an inner join would
silently drop them from the page — the classic way this "optimisation" ships as a data-loss bug.

## Phase 6 — what it costs

Drill 05's method, non-negotiable: `VACUUM (ANALYZE)`, settle, **interleave arms in one sitting**,
refuse anything under ~15% (20% on the tail). Two arms × two orgs × three rounds = 12 runs at ~85s.
`NAME=naive` / `NAME=batched`, one row each in `k6/reports/README.md`, in the same commit.

Arm switch is `LIST_STRATEGY=<arm> docker compose up -d nest_server` — both arms recreate the
container, so they differ in the variable and in nothing else.

`pg_stat_statements` stays **on for both arms** (constant, not a variable) and the honest caveat is
stated: drill 05's historical baseline did not have it, so tonight's `naive` arm is the comparator
and the 05 number is context. If the evening allows, two extra tail runs with `QUERY_COUNTER=off`
price the counter itself, and two with `PG_PRELOAD` unset price `pg_stat_statements`.

`EXPLAIN (ANALYZE, BUFFERS)`, whale org, `app.org_id` set:

- the joined list query against drill 03's recorded plan — did the two LEFT JOINs cost the
  `ORDER BY … LIMIT` its shape, or does the planner still sort-and-limit `conversations` first and
  nested-loop the two PK lookups?
- the batched tags query — is `= ANY($1::uuid[])` a bitmap or index scan on
  `conversation_tags_pkey`, and does the RLS policy still fold to a `One-Time Filter`?
- the `LATERAL json_agg` alternative, for the 2-vs-3 statement question the k6 arms deliberately
  skip.

**Predictions, written before the runs.** The point is to be checkable, not right.

1. **The tail org loses catastrophically.** ~37 extra round trips × ~0.15 ms on a 4 ms request →
   throughput down 70%+. Far outside any noise floor.
2. **The whale barely moves in percentage terms**, and that is the drill's whole thesis. The same
   ~6 ms on a 190 ms request is ~3% — inside the noise floor, i.e. **the N+1 is invisible on the
   endpoint that matters most**, while the tail org screams. If this holds, "no slow-query log ever
   flags it" is understated: our own k6 baseline would not have flagged it either.
3. **The pool does not saturate**, because drill 07 pins one connection per request. The N+1 shows
   up as hold time, not as `waitingCount`. Sampled from `/info`'s `poolStats` during a run — which
   also closes the open measurement `memory-bank/progress.md` has been carrying since drill 06.

## Phase 7 — stretch: the budget that fails a test

`apps/backend/test/query-budget.e2e-spec.ts` drives real HTTP and reads `x-query-count`:

| route | declared | asserts |
|---|---|---|
| `GET /conversations` (page of 50, tagged + assigned fixtures) | 3 | `≤ 3`, and the body still carries every name and tag — a budget met by returning less is not a fix |
| `GET /conversations` (empty page) | 3 | `= 2`, proving the batch is skipped rather than run with an empty array |
| `GET /conversations/:id`, `:id/messages`, `PATCH`, `DELETE` | default 5 | each within budget |
| any route with no `@QueryBudget` | default 5 | the default applies, so a new route is covered by omission |

**The proof it bites**: `pnpm db:test:naive` runs that same spec with `LIST_STRATEGY=naive` and is
**expected to fail**. Its verbatim red output goes in the plan's Results, exactly as drill 07
captured its phase-1 red. A budget test that has never been seen to fail is decoration.

A `query_budget_exceeded` warn line from the same run is captured too — that is the production half,
since the repo has no CI and the guide should say so rather than pretend.

## Phase 8 — the three approved cleanups

1. **`memory-bank/progress.md`**: its "Next step" predicts card 08 is `count(*)` / keyset paging.
   That was a guess about which card came next, not a wrong measurement — correct the mapping, keep
   the `count(*)` finding (it belongs to a later card), and say which prediction is now testable.
2. **Delete `AppController` / `AppService` / `app.controller.spec.ts` / `test/app.e2e-spec.ts`** and
   their `AppModule` registrations. **Consequence to handle:** `app.controller.spec.ts` is the
   backend's only unit spec, so `pnpm test` would then exit 1 with "no tests found" — the `test`
   script gets `--passWithNoTests`, and that fact goes in `progress.md` as a real gap rather than
   being hidden by a placeholder test.
3. **`main.ts`**: `void bootstrap();` with a `.catch` that logs through pino and exits non-zero,
   clearing the standing `no-floating-promises` warning.

## Files

- **New**: `apps/backend/migrations/1786964400000_tags-and-conversation-tags.js`,
  `src/observability/query-counter.ts`, `src/observability/query-budget.decorator.ts`,
  `test/query-budget.e2e-spec.ts`, `db/stats.mjs`
- **Changed**: `src/conversations/conversations.service.ts` (both strategies, new columns),
  `src/observability/{request-context,logging.interceptor}.ts`,
  `src/postgres/postgres.service.ts` (two counter increments), `src/app.module.ts`, `src/main.ts`,
  `db/seed.mjs`, `apps/backend/package.json` (`test:e2e` env, `--passWithNoTests`),
  `apps/frontend/lib/api.ts`, `apps/frontend/app/conversations/page.tsx`, `docker-compose.yml`
  (`PG_PRELOAD`), root `package.json` (`db:stats*`, `db:test:naive`), `.env.example`,
  `k6/reports/README.md`, `memory-bank/*`, `README.md`
- **Deleted**: `src/app.controller.ts`, `src/app.service.ts`, `src/app.controller.spec.ts`,
  `test/app.e2e-spec.ts`
- **Unchanged on purpose**: `k6/conversations-baseline.js` and its URL (changing `pageSize` would
  invalidate every recorded run), `src/tenancy/*`, migrations 001–003

## Verification

1. `pnpm db:migrate` applies migration 004; `pnpm db:migrate:down` reverses it; re-apply. Then
   **`pnpm db:reset` end to end** — it re-seeds, so run it before the k6 evening, not during it.
2. `pnpm check:tenancy` lists **five** tables with RLS, policies and `WITH CHECK`. Break it
   deliberately (`ALTER TABLE conversation_tags DISABLE ROW LEVEL SECURITY`), confirm it fails,
   restore.
3. `pnpm db:test` — the existing 45 pass plus the new budget suite. Expect fixture churn in the
   older suites: they now need tags and an assignee to assert against.
4. Naive: `curl -s -H 'x-org-id: 1' 'localhost:3002/conversations?page=1&pageSize=50' -D-` →
   `x-query-count` ≈ 92, `query_budget_exceeded` in the logs, and
   `docker compose logs postgres_db | grep -c 'rid=<id>'` agreeing with it.
5. `pnpm db:test:naive` fails, verbatim output captured.
6. Batched: same curl → `x-query-count: 3`, no warn line, and the page renders names and chips at
   `localhost:3001/conversations`.
7. `PG_PRELOAD=pg_stat_statements`, `db:stats:on`, `db:stats:reset`, one page load, `db:stats` — the
   per-row lookup is row 1 by `calls` and *not* row 1 by `mean_exec_time`. Record both orderings;
   that contrast is the writeup's answer.
8. 12 k6 runs, interleaved, labelled, indexed in `k6/reports/README.md`.
9. `pnpm lint` clean (the `no-floating-promises` warning gone), `pnpm format` before done.
10. `drills/08-n-plus-one.md` written, with the three required sections (`Is this production
    ready?`, `Honest gaps`, `What I'd do differently at 10x`), then `memory-bank/` updated —
    `history.md` row flipped to `implemented`, `progress.md` re-pointed at card 09 — and the PR
    opened.

## Results

**Status: shipped.** 51 e2e tests pass (45 pre-existing + 6 new query-budget tests).

### Query counts

| | naive | batched |
|---|---|---|
| `pageSize=50`, org 1 | 87 statements, 90 round trips | 3 statements, 6 round trips |
| `pageSize=20`, org 1 — **the k6 URL** | 33 statements | 3 statements |
| `pageSize=20`, org 150 — **the k6 URL** | 37 statements | 3 statements |
| `pageSize=12`, budget-test fixture | 22 statements | 3 statements (2 on an empty page) |

**Which count belongs to which result, because the first version of this table got it wrong.**
`k6/conversations-baseline.js` requests `?page=1&pageSize=20` and always has — changing it would
invalidate every run since drill 05. So the throughput numbers below are what fixing a **37**-query
request buys on the tail, not an 87-query one; 87 is the `pageSize=50` curl from the detection
exercise, which k6 never issued. The two were welded together in this table's first draft (and in
`README.md`), which is how a real measurement turns into a wrong sentence: both numbers were
correct, the pairing was not. The `pageSize=20` rows were measured on review to close the gap.

`queries` and `roundTrips` are two different counters on purpose (`request-context.ts`) —
`roundTrips` also counts `BEGIN`/`set_config`/`COMMIT`, which drill 07 priced at ~0.94ms/request
and which the budget deliberately does not count against, matching the card's "≤3" language.

### The k6 table

Drill 05's method: `VACUUM (ANALYZE)`, interleave arms in one sitting, refuse deltas under the
noise floor. 2 arms × 2 orgs × 3 rounds = 12 runs, `pg_stat_statements` **off** throughout (matches
every prior drill's baseline convention — see "What the plan got wrong" below for why it started
otherwise). Medians:

| org | arm | p50 | p95 | p99 | throughput |
|---|---|---|---|---|---|
| 150 (tail) | naive | 20.47 ms | 30.73 ms | 49.15 ms | 449.18 req/s |
| 150 (tail) | batched | 7.53 ms | 11.23 ms | 14.56 ms | 1244.57 req/s |
| 1 (whale) | naive | 418.77 ms | 827.44 ms | 1027.26 ms | 19.88 req/s |
| 1 (whale) | batched | 522.82 ms | 1024.05 ms | 1136.09 ms | 16.23 req/s |

**Tail: −63.2% p50, −63.5% p95, −70.4% p99, +177.1% throughput (2.77×).** Clean and large —
within-arm spread was 2-9% on the batched side (naive's own spread ran 17-25%, driven by round 3
alone; still dwarfed by a 63-177% delta). Prediction 1 confirmed, more emphatically than predicted.

**Whale: k6 says +23.8% p95, −18.4% throughput — batched *worse*. Do not trust that number.**
Within-arm spread was 14-17% in *both* arms — comparable in size to the 20-24% delta between them —
so by this repo's own rule (refuse anything under ~15%/20%) the whale's k6 comparison is **inside
the noise floor, unproven**. Prediction 2 ("barely moves, may get faster") is neither confirmed nor
refuted by k6 alone. The `EXPLAIN` below is the trustworthy number instead, because it removes
concurrency — the whale's actual confound, found while investigating this exact discrepancy (see
below).

**Stretch — `pg_stat_statements` (tail, 1 round):** preloaded → 1329.15 req/s vs off's 1244.57
(+6.8%, inside noise — unmeasurable, same as drill 06's tracing-verbosity check: suspected of
costing something, measured and didn't).

**Stretch — what the counter costs, measured twice because the first one was invalid.**

The first attempt recorded `QUERY_COUNTER=off` → 1269.43 req/s vs `on`'s 1244.57 (+2.0%) and called
it the price of the counter. **It was not.** `recordQuery()`/`recordRoundTrip()` were called
unconditionally from `PostgresService`; only the interceptor's reporting was gated. So the `off`
arm still paid an `AsyncLocalStorage` lookup and two increments per statement, and that +2.0%
priced the interceptor's `tap` alone — a question nobody asked. Found on review, by reading
`postgres.service.ts` against this file's own claim; confirmed in one command by running
`QUERY_COUNTER=off LOG_LEVEL=debug` and seeing `"queries":1` still in the `handler` line. Fixed in
`request-context.ts` (a `COUNTING_ENABLED` guard in both recorders) and re-measured:

| arm | round 1 | round 2 | mean |
|---|---|---|---|
| `QUERY_COUNTER=on` | 1383.37 req/s | 1296.73 | **1340.05** |
| `QUERY_COUNTER=off` | 1350.98 req/s | 1250.87 | **1300.93** |

**Still unmeasurable, and now honestly so.** `off` came out 2.9% *slower* than `on` — the wrong
sign, since disabling work cannot cost throughput — against a within-arm spread of 6.7% (`on`) and
8.0% (`off`). Both are dwarfed by a monotonic drift across the sitting in *run order* regardless of
arm: 1383 → 1351 → 1297 → 1251, a 9.6% slide over four consecutive runs. That drift is the finding
worth keeping: interleaving arms protects against a *step* change between them, not against a ramp
underneath both, and four runs is too few to fit one out. The counter is too cheap to see at the
tail — the same conclusion as before, but this time the arm being measured is the arm named.

### `EXPLAIN (ANALYZE, BUFFERS)` — the whale, isolated from concurrency

Single-connection, `app.org_id` set, no k6 load. This is what prediction 2 should be judged against.

| query | time | plan |
|---|---|---|
| naive list (unchanged SQL) | 154.6 ms | `Parallel Seq Scan` on `conversations`, `Buffers: hit=15007 read=10477` — card 09's missing `(org_id, updated_at DESC, id DESC)` index, not this card's problem |
| batched list + 2 LEFT JOINs | 184.4 ms | same seq scan, plus two in-memory `Hash Left Join`s against `memberships`/`users` (each <0.5ms) |
| batched tags (page of 20 ids) | 1.4 ms | `Index Only Scan` on `conversation_tags_pkey`, `Hash Join` against a 1051-row `Seq Scan` on `tags` |

**The joins cost +29.9ms / +19.3% in isolation** — real, measurable, and small next to the 154.6ms
the still-open card-09 index gap already costs every list query, naive or batched. That gap, not
card 08, is what dominates the whale's absolute latency and what k6's concurrent load amplifies into
the noisy, unreliable numbers above (10 VUs each doing a ~230MB-class scan against a deliberately
undersized 128MB `shared_buffers` thrash the cache in a way one isolated `EXPLAIN` cannot show).

**The `LATERAL json_agg` alternative (2 statements instead of 3) was measured, not just described,**
and rejected for a reason the statement count alone would never surface: 174.2 ms — nominally
*faster* than the 3-statement version — but `Sort Method: external merge  Disk: 18352kB` instead of
the LEFT JOIN version's in-memory top-N heapsort. The correlated subquery sits between the sort and
the `LIMIT`, so the planner cannot push the limit into the sort the way it does for a plain join, and
1M+ matching rows get fully sorted on disk before the top 20 are picked. Fewer round trips is not
free — here it trades a network-visible cost for a disk-visible one that only shows up under
`BUFFERS`, not in the headline execution time.

### The detection exercise

Run in order — `pg_stat_statements` first, the statement log second, the counter last — against the
naive arm, so each is judged on what it would have told you *without* already knowing the code.

1. **`pg_stat_statements`.** Comments strip before the parse tree is even built — SQL comments are a
   lexer-level construct, invisible to the AST `queryid` is hashed from. Confirmed, not assumed: the
   50 identical per-row tag lookups inside one request collapsed to one row (`calls=50`), and a
   *second* request with a *different* `rid` comment added to the **same** row (`calls=100`) rather
   than minting a new one. `dealloc` stayed `0` — the risk the plan flagged (`rid` fragmenting
   `queryid`s until `pg_stat_statements.max` evicts) did not materialize.
   - **`top by calls`** puts both per-row-lookup shapes at rows 1-2 (50, 35) — the N+1 is immediate.
   - **`top by mean_exec_time`** does not show them at all — they rank near the bottom (0.010-0.013ms
     mean) below the two genuinely slow one-off queries (list ~80ms, count ~19ms in that sample).
     This is the provable version of "an N+1 hides from any latency-sorted view because each call is
     individually fast" — sorting the *right* way (`calls`) is what finds it.
   - **Real limitation, found by checking the stored text**: the `query` column holds only the
     *first* call's literal text, `rid` comment included — stale evidence, useful for spotting a
     *shape* that recurs a suspicious number of times, useless for attributing one occurrence to one
     specific request.
2. **The statement log.** `docker compose logs postgres_db | grep -c 'rid=<id>'` is **not** a
   round-trip count as the plan first assumed — it is exactly **3×** the true count. `pg`'s extended
   query protocol logs a `parse`/`bind`/`execute` line per statement, and each one echoes the full
   statement text, comment included. Confirmed exactly: 261 matching lines ÷ 3 = 87.0, matching the
   application's own counter to the integer. The corrected rule — divide by 3, or grep one phase
   only — is now what the guide says; the plan's original phrasing was wrong and is not how it reads
   any more.
3. **The counter.** Ground truth by construction, `x-query-count`/debug logs — exactly what
   `PostgresService.runOn()` was actually called with, no arithmetic required.

**Which would have caught this first in production: `pg_stat_statements`.** Debug-level statement
logging is far too expensive to leave on (drill 06 measured `-23` to `-35%` tail throughput from it),
so the statement log is a deliberate, occasional check — not a standing production instrument.
`pg_stat_statements` is always-on infrastructure, one well-known query away from an answer, and
covers every endpoint at once rather than only the one somebody already suspected.

**Would an ORM's version of this bug still be caught?** `pg_stat_statements` and the statement log:
**yes**, unaffected — both operate on the SQL Postgres actually receives, blind to what produced it.
An ORM lazily loading `conversation.assignee.name` inside a serializer sends the identical shaped
`SELECT` 50 times either way. The counter: **yes**, but only because it is wired into
`PostgresService`, which every query — ORM-issued or not — is forced through by this repo's `@Global()`
chokepoint design; a counter bolted onto a driver nothing is forced to use would not see it. The one
detection method that stops working with an ORM is **"I remember writing that loop"** — there often
is no loop to remember, since the N+1 lives inside a lazy-loaded association a serializer touches.

### The budget test proving itself

`pnpm db:test:naive`: 50 of 51 tests pass; only the budget assertion fails —

```
● query budget (e2e) › a full page of assigned, tagged conversations stays within budget
  expect(received).toBeLessThanOrEqual(expected)
  Expected: <= 3
  Received:    22
```

The other 50 — including the *same* endpoint's data-correctness checks — passing is the point: the
naive path is functionally indistinguishable from the batched one, which is exactly why "no
slow-query log ever flags it" understates the problem. Only the budget catches it.

### Bug found while implementing (not while reading)

**`@QueryBudget(3)` on `ConversationsService.list()` had no effect** — the interceptor kept
reporting `budget:5` (the default) even under the naive arm. `LoggingInterceptor` reads metadata via
`Reflector.getAllAndOverride(KEY, [context.getHandler(), context.getClass()])`, which resolves to
the **controller's** route handler actually invoked by Nest — not whichever service happens to be
injected. A decorator on the service method attaches to a different function object entirely and is
silently never read; nothing fails to compile, nothing throws. Found only by testing the naive arm
and seeing the wrong budget number in the log, moved to `ConversationsController.list()`, confirmed
with the same test. Recorded in both files' comments so it cannot be "corrected" back.

### What the plan got wrong

1. **Leaving `pg_stat_statements` on for both k6 arms, as the plan's phase 6 specified, was a
   mistake — corrected mid-measurement, not on paper.** The plan called it "constant, not a
   variable" and reasoned that made it safe; in practice enabling it required recreating
   `postgres_db` (postmaster-context), and every later `docker compose up -d nest_server` call — one
   per arm switch — silently reverted `shared_preload_libraries` to empty and recreated the
   container *again*, because `PG_PRELOAD` was only ever set in the one command that turned it on and
   this repo's env-var forwarding reads the shell fresh each time. Diagnosed from the whale's
   anomalously large numbers, confirmed with `docker inspect --format '{{.RestartCount}}'`, and
   resolved by simply not fighting it: `pg_stat_statements` ended up off (the production default) for
   all 12 primary runs, which is what the standing repo rule ("new instrumentation ships off by
   default") would have said to do in the first place. Its own cost is now two clearly-labelled
   stretch runs instead of a silent constant in the primary table.
2. **"`grep -c 'rid=<id>'` — one request's round trip count straight out of Postgres" was wrong
   as written**, corrected above and in the guide: it is 3× the count, from the extended query
   protocol's three logged phases per statement.
3. **The naive/batched query counts were close to predicted but not exact**: 87 not ~92 (fewer of
   page 1's 50 rows were assigned than the ~80% seed-wide rate suggests — a page is not a random
   sample of the whole org), and the budget-test fixture (`pageSize=12`) gave 22, a number the plan
   never predicted because the fixture size wasn't fixed until the test was written.
4. **`@QueryBudget`'s placement bug**, above — not anticipated by the plan at all.
5. **The existing 45 e2e tests needed no fixture changes**, contrary to the plan's expectation —
   `assigneeName`/`tags` are additive fields, and neither older suite asserts on the full response
   shape strictly enough to notice them arriving.
6. **`QUERY_COUNTER=off` did not turn off counting**, so the arm the plan designed to price the
   counter priced something else. The plan specified it correctly ("no counting, no tap"); the
   implementation gated only the tap. Caught in review, fixed, re-measured — the numbers above.
   The lesson is not "read the code more carefully": it is that **a switch whose whole purpose is
   to be a measurement arm needs a test that fails when it stops switching**, and this one had
   none. The counter's own e2e suite asserts what the counter reports, never that `off` is off.
7. **Two correct numbers, welded into a wrong sentence.** The results table labelled the
   `pageSize=50` count "(k6 URL)" when the k6 URL is `pageSize=20`, and `README.md` then paired
   "87 queries" with the 2.77× throughput those runs produced. Also caught in review. Nothing was
   mis-measured; the pairing was invented in the writeup, which is the easiest place in this
   whole card to introduce an error nobody can reproduce later.
