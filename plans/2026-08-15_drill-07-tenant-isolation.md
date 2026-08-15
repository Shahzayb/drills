# Drill 07 — Prove a tenant leak, then make the class of bug unwritable

**Status:** planned

## Context

`GET /conversations` is correctly scoped today, and it is correctly scoped because a human
remembered to type `WHERE org_id = $1`. That is not a guarantee, it is a habit. The failure this
drill is about is the one where a new endpoint ships and the habit lapses: for nine days one
customer's inbox is readable by another, and nobody notices, because nobody goes looking for data
they did not expect to have.

Two things make this repo an unusually honest place to run the drill:

- **Every tenant-owned row already carries `org_id` directly** (drill 02's load-bearing rule), so a
  row-level policy needs no join to find the tenant.
- **The app connects to Postgres as `POSTGRES_USER`, which is a superuser.** Superusers bypass RLS
  unconditionally — `FORCE ROW LEVEL SECURITY` does not help, since that only covers the *owner*.
  So a first pass at RLS here would appear to work, change nothing, and pass a test suite that was
  never actually protected. Fixing that is part of the mechanism, not a footnote.

The deliverable is a test suite that hunts leaks, a mechanism that makes the leak structural rather
than remembered, and a number for what the mechanism costs against drill 05's baseline.

## The mechanism, and what it rejected

**Chosen: Postgres row-level security**, driven by a transaction-local `app.org_id` set once per
request, with the app connecting as a non-superuser, non-owner role.

The property that decides it: **it fails closed and it holds below the application.** With no
tenant context set, `current_setting('app.org_id', true)` is NULL, the policy predicate is NULL, and
every scoped table returns zero rows. A forgotten filter becomes an empty page, not another
tenant's inbox. And it holds even for code that never went through the seam — which is the only way
"unwritable" means anything, because a TypeScript seam protects exactly the code that chose to use
it.

Rejected, with the honest reason:

- **Repository layer over drill 01's `query()`.** Rejected not because it is weak in principle but
  because in *this* repo `PostgresService` is `@Global()` and injectable anywhere, so the seam is
  advisory: a `postgres.query('SELECT … FROM conversations')` in a new service compiles, passes
  review, and leaks. Its enforcement would live entirely in a lint rule — i.e. in the stretch goal
  — and a lint rule is a thing a human can add an `eslint-disable` to. It is kept as the *shape* of
  the API (`withOrg(orgId, …)` is the only way to run a scoped query) but not as the guarantee.
- **Schema-per-tenant.** Rejected on operational cost that this repo can actually name: 200 orgs
  means 200 schemas, every migration runs 200 times, and drill 04's single-transaction `COPY` seed
  stops being one load. It also swaps a per-row predicate for per-connection `search_path` state,
  which is the *same* pooled-session-state hazard as the rejected option below, just with a bigger
  blast radius when it goes wrong.
- **Session-level `SET app.org_id` instead of transaction-local.** Rejected specifically: `pg`'s
  pool hands the same connection to the next request, and `pg-pool` has no reliable reset hook. A
  missed reset leaks one tenant's context into another tenant's request — a worse bug than the one
  being fixed, and one that only appears under concurrency. `set_config(…, is_local => true)`
  cannot outlive its transaction.
- **Opening the scope in an interceptor and stashing the client in the drill 06
  `AsyncLocalStorage`.** Genuinely tempting: it would make an unscoped query inside a request
  impossible. Rejected because the transaction would then span response serialisation and every
  interceptor after it, turning request duration into transaction duration and connection-hold
  time. Recorded as the thing to revisit if the seam turns out to be forgettable in practice.

## The arc, and why the diff is the point

Phase 1 ships four new endpoints written the way the scenario describes — **no `org_id` filter in
their SQL at all** — and a test suite that proves they leak. Phase 2 adds the mechanism and turns
that suite green **without editing a single line of those endpoints' SQL, and without editing a
single test**. The zero-line diff between "leaking" and "safe" is the whole argument.

`GET /conversations` keeps its explicit `WHERE org_id = $1`. Two reasons: it is the query drill 05
baselined and cards 08/09/10 compare against, and belt-and-braces on the one hot path is a
defensible production choice. The four new endpoints stay filterless *on purpose* — that is what
makes "remove the mechanism and watch it fail" a real proof rather than a claim.

## Phase 0 — environment

The worktree is a different Compose project name, which would mean a fresh volume and a fresh seed.
Copy `.env` from the main worktree and add `COMPOSE_PROJECT_NAME=drills` so the existing seeded
`drills_pgdata` is reused — same 2.5M rows drill 05 measured, or the cost comparison is against
different data.

Then `pnpm docker:up`, `pnpm db:migrate:status`, and a `VACUUM (ANALYZE)` before any measurement
(drill 04: `ANALYZE` alone leaves `count(*)` a seq scan and moves the whale by 2x).

Pre-drill-07 commit, for phase 4's `before` arm: **`219f91b`**.

## Phase 1 — the leak, and the test that catches it

`apps/backend/src/conversations/` gains four handlers, all filterless:

| route | SQL, as written | the excuse a human would give |
|---|---|---|
| `GET /conversations/:id` | `… WHERE id = $1` | "the id is a uuid" |
| `PATCH /conversations/:id` | `UPDATE … SET status = $2 WHERE id = $1` | "you can only reach it from the list" |
| `DELETE /conversations/:id` | `DELETE FROM … WHERE id = $1` | same |
| `GET /conversations/:id/messages` | `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = $1` | "the parent lookup already scoped it" — it did not; the join reaches `messages` through a table nobody scoped |

Two edge decisions that are security decisions, not style:

- `:id` goes through `ParseUUIDPipe`. Without it a non-uuid reaches Postgres, errors `22P02`, and
  returns a 500 that distinguishes malformed from missing.
- A row that exists but belongs to someone else returns **404, not 403**. A 403 confirms the row
  exists, which is a cross-tenant existence oracle — enough to enumerate a competitor's inbox size.

New: `dto/update-conversation.dto.ts` (`status` only, `@IsIn(['open','closed'])`).

`apps/backend/test/tenant-isolation.e2e-spec.ts` is written now and is red now. It is the
deliverable. Run it and capture the failures verbatim — the "nine days" story is more convincing as
output than as prose.

## Phase 2 — the mechanism

### Migration `003_tenant-isolation-rls.js`

Hand-written SQL inside `pgm.sql()`, per drill 02's rule.

1. `app_current_org()` — `LANGUAGE sql STABLE PARALLEL SAFE`, returning
   `nullif(current_setting('app.org_id', true), '')::bigint`. `STABLE` matters: a `VOLATILE`
   function in the predicate cannot be used as an index qualifier and would cost the whale a scan.
   The `nullif` is not decoration — `''::bigint` raises, so an empty string would turn a
   fail-closed policy into a 500.
2. `CREATE ROLE app_user LOGIN` with a password from the environment, then `GRANT USAGE ON SCHEMA
   public`, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`, `GRANT USAGE, SELECT ON ALL
   SEQUENCES`. **No `ALTER DEFAULT PRIVILEGES`** — a new table should require an explicit grant, so
   adding one is a moment where somebody thinks about its policy. Phase 5's audit is the backstop.

   **A role is a cluster object, the migration ledger is a database one — and `pnpm db:reset` is
   `DROP SCHEMA public CASCADE`.** So after a reset the tables, the function and `pgmigrations` are
   gone but `app_user` still exists, and a naive `CREATE ROLE` fails the whole migration on a
   command this repo runs constantly. The role creation is guarded (`DO $$ … IF NOT EXISTS (SELECT
   FROM pg_roles …)`) and the grants are re-applied unconditionally, because after a reset the role
   survives with grants on objects that no longer do.
3. `ENABLE ROW LEVEL SECURITY` + one `FOR ALL … USING (…) WITH CHECK (…)` policy per table carrying
   `org_id`: `conversations`, `messages`, `memberships`.
   - Policies are `TO PUBLIC`, not `TO app_user`. A role-targeted policy silently protects nothing
     when a second app role is added later, and PUBLIC still exempts the owner and superusers,
     which is exactly the split we want.
   - **No `FORCE ROW LEVEL SECURITY`.** The owner deliberately stays exempt: migrations and drill
     04's `COPY` seed run as `POSTGRES_USER` and must bypass. The cost of that decision is that
     anything running as owner is unprotected, which goes in `memory-bank` as a known risk.
   - `WITH CHECK` is not optional: `USING` alone lets a tenant write a row *out* of its own scope.
4. `organizations` and `users` get no policy, and the reason is recorded: `organizations` is the
   tenant registry (no tenant path reads it), `users` genuinely has no `org_id` and is shared
   across orgs by design — a real leak surface in a real product, named rather than hidden.

`down` reverses it: drop policies, disable RLS, revoke, drop role, drop function.

### Connection identity

`.env.example` and `.env` gain `POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD`. `docker-compose.yml`
needs no change — `nest_server` already has `env_file: .env`, so both variables arrive without a
line of Compose.

`PostgresService` connects with them and **throws at construction if they are unset** — it does not
fall back to `POSTGRES_USER`. A silent fallback to the superuser is precisely the failure mode this
drill exists to remove, and it would be invisible: every test still passes.

`migrate.config.mjs` and `db/seed.mjs` keep using `POSTGRES_USER`. That split — owner for
maintenance, app role for serving — is the whole reason the policies bite.

### The seam — `apps/backend/src/tenancy/`

`tenant-db.service.ts` exports `TenantDb.withOrg(orgId, fn)`:

```
const client = await pool.connect();
BEGIN
SELECT set_config('app.org_id', $1, true)     -- is_local => true
… fn(scoped) …
COMMIT / ROLLBACK, always release()
```

`fn` receives a `TenantQuery` whose only method is `query(text, params)`, bound to that client. The
raw `Pool` stays private, so drill 01's chokepoint property survives: `PostgresService.query()` is
refactored into a shared `runOn(executor, …)` so the pinned-client path keeps the same `db_query` /
`slow_query` / `db_query_failed` logging and the same trailing `/* rid= */` comment. No duplicated
instrumentation.

The `BEGIN` is load-bearing and gets a comment in the file: `set_config(…, true)` outside an
explicit transaction applies to the implicit single-statement transaction and evaporates before the
next statement. Drop the `BEGIN` and everything returns zero rows — loudly, which is the good
failure.

`BEGIN` / `set_config` / `COMMIT` are **not** logged as three `db_query` lines. Drill 06's output is
already one line per query and tripling it would make `pnpm logs:trace` unreadable for a two-query
request. They get one `tenant_scope` debug event with the org and the scope's `durMs` instead —
which is also the number phase 4 wants.

`ConversationsService` methods wrap their work in `withOrg`. `list()` keeps its explicit filter; the
four new handlers' SQL is **not touched**.

Wiring: a plain `TenancyModule` exporting `TenantDb`, imported by `ConversationsModule`. Not
`@Global()` — there is one consumer, and structure gets added when there is content for it.

## Phase 3 — the adversarial suite

`apps/backend/test/tenant-isolation.e2e-spec.ts`, written in phase 1, unedited in phase 2.
Fixtures: two orgs, A (victim) and B (attacker), conversations and messages under each, created
through `withOrg` — which exercises `WITH CHECK` for free.

| # | case | asserts |
|---|---|---|
| 1 | cross-tenant **read by id** | A asking for B's conversation → 404; and a control that B gets 200 for the same id, so the 404 is isolation and not a typo |
| 2 | cross-tenant **list** | A's list contains none of B's ids |
| 3 | cross-tenant **update** | `PATCH` → 404 **and** B re-reads the row unchanged. The second half is the real assertion: a 404 with a completed write is the nightmare |
| 4 | cross-tenant **delete** | `DELETE` → 404 **and** the row is still there when B looks |
| 5 | **join through an unscoped table** | `GET /conversations/{B}/messages` as A → 404/empty, and B's message text appears nowhere in the body |
| 6 | **write a row out of your own tenant** | inside `withOrg(A)`, `UPDATE conversations SET org_id = B` → rejected (`42501`). `WITH CHECK` is what stops smuggling |
| 7 | **bypass the seam entirely** | raw `postgres.query('SELECT … FROM conversations')` with no scope → 0 rows. This is the one a TypeScript-only mechanism cannot make pass |
| 8 | **insert under the wrong scope** | inside `withOrg(A)`, insert with `org_id = B` → rejected |
| 9 | **scope does not leak across the pool** | `withOrg(A)`, then immediately a raw unscoped query on the same pool → still 0 rows. This is the test that earns the rejection of session-level `SET`; with `SET` instead of `set_config(…, true)` it returns A's rows to whoever got that connection next |

Nine against a required five. 1, 3, 4, 5, 7 and 8 all fail with the mechanism removed.

### Proving the last part by removing it

Documented psql sequence (`ALTER TABLE … DISABLE ROW LEVEL SECURITY` for the three tables), then
`pnpm db:test`, then re-enable. Which tests fail, and the verbatim output, get recorded below.

`pnpm rls:status` is added, matching the `db:log:status` pattern — read-only, so checking is
cheaper than assuming. **`rls:on` / `rls:off` are deliberately not package scripts**: a one-word
command that disables tenant isolation is a footgun that outlives the drill. The psql is written
down here and in the guide instead.

## Phase 4 — what it costs

Drill 05's method, non-negotiable: `VACUUM (ANALYZE)`, settle, **interleave arms in one sitting**,
refuse anything under ~15% (20% on the tail).

Three arms, two orgs (1 = whale, finds query cost; 150 = tail, finds fixed per-request cost), two
rounds — 12 runs at ~85s. `apps/backend` is bind-mounted under `nest start --watch`, so swapping
arms is a checkout and a reload, not a rebuild.

| arm | how | isolates |
|---|---|---|
| `before` | detached checkout of `219f91b`, old code, owner connection | drill 05's path, re-measured tonight so laptop drift is not in the delta |
| `txn-only` | new code, app role, **RLS disabled** on the three tables | the wrapper: `BEGIN` + `set_config` + `COMMIT`, one pinned client, and drill 03's `Promise.all` now serialising on it |
| `rls-on` | full mechanism | the policy predicate itself |

Two mechanical notes on the `before` arm: a plain `git checkout <sha> -- apps/backend/src` leaves
the *new* files behind (they are untracked at that sha, so nothing deletes them), which compiles but
is not honestly "before" — use a detached checkout of the whole tree and come back. And the policies
stay on the tables during that arm; the owner bypasses them, which is exactly the old path.

Also: `EXPLAIN (ANALYZE, BUFFERS)` of the list query with `app.org_id` set, compared against the
plan drill 03 recorded — the question is whether the added policy predicate changed the plan, or
whether `STABLE` let it fold into the same index qual. **And the same for `messages`**, which drill
02 deliberately left with an `org_id` FK and *no index*: a policy predicate on an unindexed column
is a filter every messages query now carries. The messages endpoint seeks by `conversation_id`
(indexed) so it should be a cheap recheck on a handful of rows — but "should be" is what this drill
does not accept, so it gets an `EXPLAIN` of its own. If it is not cheap, that is a finding worth
more than the k6 table.

**Predictions, written before the runs.** The point is to be checkable, not right.

1. **Tail org loses double digits.** Drill 06's finding was that the plumbing costs a fixed
   ~0.9ms/request, and this adds two round trips plus a connection acquire to a 2ms request.
2. **Whale is roughly unchanged, and may get *faster*.** Serialising the list and count queries adds
   latency, but it halves connection demand from the 2:1 oversubscription drill 05 measured at
   10 VUs. Two effects in opposite directions; that is why it gets measured.
3. **`rls-on` minus `txn-only` is small** — one `STABLE` function call folded into an existing index
   qual. If it is not small, the plan changed, and the `EXPLAIN` will say so.

Reported as a % against the 05 baseline as the card asks, with the caveat stated plainly: the
`before` arm run the same evening is the honest comparator, and the 05 number is the historical one.

The 12 summaries get `NAME=` labels and a row each in `k6/reports/README.md`, in the same commit —
this repo's rule is that an unlabelled run is not evidence.

## Phase 5 — stretch: the check that fails the build

Two halves, and the guide is honest that neither alone is sufficient.

**Static (`apps/backend/eslint.config.mjs`).** A scoped block adding `no-restricted-imports` for
`PostgresService` outside `src/tenancy/**`, `src/postgres/**`, `src/health/**` and `src/info/**`
(the last two are legitimately tenant-free), plus a `no-restricted-syntax` selector catching
`.query(` on a member named `postgres`. This raises the cost of doing the wrong thing by accident.
It does not prove anything — `eslint-disable` is one line.

**Integration (`apps/backend/db/check-tenancy.mjs`, `pnpm check:tenancy`).** A plain `.mjs` script
against the live database, failing with a list if:

- any table with an `org_id` column has `relrowsecurity = false` or zero policies;
- any of those policies lacks a `WITH CHECK` (`pg_policies.with_check IS NULL`);
- the app role is a superuser, has `rolbypassrls`, or owns the tables it is supposed to be
  constrained by.

That last check is the one that would have caught the superuser problem on day one instead of never.

Because the repo has no CI, the audit is *also* asserted as a final `describe` block in
`tenant-isolation.e2e-spec.ts`, so `pnpm db:test` fails on a new unprotected table. That is the
closest thing to "fails CI" this repo currently has, and the guide says so rather than pretending.

## Files

- New: `migrations/003_tenant-isolation-rls.js`, `src/tenancy/tenant-db.service.ts`,
  `src/tenancy/tenancy.module.ts`, `src/conversations/dto/update-conversation.dto.ts`,
  `test/tenant-isolation.e2e-spec.ts`, `db/check-tenancy.mjs`
- Changed: `src/conversations/conversations.{controller,service,module}.ts`,
  `src/postgres/postgres.service.ts` (refactor `query` → shared `runOn`, app-role credentials),
  `eslint.config.mjs`, `package.json` (root: `check:tenancy`, `rls:status`), `.env.example`
- Unchanged on purpose: `docker-compose.yml` (`env_file: .env` already carries the new variables),
  `k6/conversations-baseline.js`, `db/seed.mjs`, `migrate.config.mjs`, the frontend

## Verification

1. `pnpm docker:up && pnpm db:migrate` — migration 003 applies, `pnpm db:migrate:down` reverses it
   cleanly, re-apply. Then **`pnpm db:reset` end to end**, which is the one that catches the
   surviving-role trap — and it re-seeds, so run it before the k6 evening, not during it.
2. `pnpm db:test` — the existing 27 tests still pass, plus the new suite. Nothing in
   `conversations.e2e-spec.ts` changes.
3. Phase 1 red / phase 2 green captured verbatim, with no test edits between them.
4. The removal proof: disable RLS, `pnpm db:test`, record the failures, re-enable, green again.
5. `pnpm check:tenancy` passes; break it deliberately (`ALTER TABLE messages DISABLE ROW LEVEL
   SECURITY`) and confirm it fails with a useful message; restore.
6. `pnpm lint` — confirm the ESLint rule fires by adding a `PostgresService` import to
   `conversations.service.ts`, then reverting.
7. 12 k6 runs, interleaved, labelled, indexed in `k6/reports/README.md`.
8. `pnpm format` before calling it done.

## Results

_Filled in as the drill runs._

## Revised while shipping

_What the plan got wrong, recorded rather than quietly fixed._
