# Drill 14 — Two agents claim the same ticket, end to end

Card 14. The drill is deliberately both halves: a version check on the server, and a UI that has
to un-tell an optimistic update it already showed.

**Status:** in progress

---

## Context

`conversations.assignee_id` has existed since migration 001 and **nothing writes it**. The seed
sets it; no endpoint changes it. So the inbox has an assignee column and no way to claim a ticket.

The card's scenario: two agents open the inbox, both see the same unassigned conversation, both
click "assign to me" within the same second. A plain `UPDATE … SET assignee_id = $me WHERE id = $1`
gives both of them a 200. Last write wins, the loser believes they own the ticket, and the customer
gets two replies or none. No error, no log line — the same shape of silence as drill 13's lost
update, one layer up.

Two halves, and the card is explicit that the second is the one people get wrong:

1. **Server.** A `version` column. Assignment succeeds only if the version matches what the client
   read. Exactly one winner; the loser gets a distinguishable conflict, not a 500.
2. **UI.** The assign button is a Server Action with an optimistic update. When the write
   legitimately fails, the UI has to un-tell a lie it already told — converge on true server state
   and say why, with no full reload.

Then measure conflict rate and successful-write throughput at 2, 10 and 50 concurrent claimers on
one row, and the stretch: the same server half done pessimistically with `FOR UPDATE`, both
throughput curves on one chart, and the crossover explained.

Prereq 13 is what makes this cheap: `TenantDb.withOrg` already carries an isolation level and a
retry loop, `db/quota.mts` is the instrument shape to copy, and drill 13 already established that
"the broken arm as a permanent red test" is how a concurrency bug gets proven rather than argued.

---

## What ships

### Arms

One switch, three arms, one commit — the repo's rule since drill 07 is that an A/B's arms must
differ only in the variable, never in the checkout.

| `ASSIGN` | Mechanism | Outcome for the second claimer |
|---|---|---|
| `lww` | `UPDATE … WHERE id = $1`, no version check | 200. Silently wins. **The bug.** |
| `optimistic` (default) | `UPDATE … WHERE id = $1 AND version = $2` | 409 with the true current state |
| `pessimistic` | `SELECT … FOR UPDATE`, decide inside the lock | 409, after waiting for the lock |

`optimistic` is the default because it is what ships. `lww` is a permanent red arm (`db:test:lww`
must fail) and `pessimistic` is the stretch's other curve.

The claim rule, identical on all three arms: **you may write the assignee if the row is unassigned,
or if it is already assigned to you.** `optimistic` enforces it with the version the client read;
`pessimistic` enforces it against the row as it is now, under a row lock; `lww` does not enforce it
at all.

### Schema

`apps/backend/migrations/1788825600000_conversations-version.js`

```sql
ALTER TABLE conversations ADD COLUMN version integer NOT NULL DEFAULT 1;
```

No index — `version` is only ever read and written by primary key. Hand-written SQL in `pgm.sql()`,
same as every migration here. Worth timing on the way past: since Postgres 11 a `NOT NULL DEFAULT
<constant>` add is metadata-only (`pg_attribute.attmissingval`), so this should not rewrite 2.5M
rows. Measure it rather than assert it — the number goes in the drill.

### Endpoint

`POST /conversations/:id/assign` on the existing `ConversationsController`.

Body — `apps/backend/src/conversations/dto/assign-conversation.dto.ts`:

```ts
{ assigneeId: string | null; version?: number }
```

- `assigneeId` is a `bigint` membership id as a string, or `null` to release. String all the way
  in, same reasoning as `ConversationSummary.assigneeId` going out.
- `version` is `@IsOptional()` in the DTO and **required by the service on the `optimistic` arm** —
  a missing version there is a 400. Not `@ValidateIf`: `conversations.service.ts` already records
  why that reads like a guard and is the opposite of one.

Responses:

| Code | When | Body |
|---|---|---|
| 200 | claimed | the updated `ConversationSummary`, `version` included |
| 400 | `optimistic` arm, no `version` sent | Nest's validation body |
| 404 | no such conversation in this org | `conversation not found` |
| 409 | version moved, or someone else holds it | `{ error: 'conflict', message, current: { assigneeId, assigneeName, version, updatedAt } }` |

The 409 carrying `current` is the whole point: the loser's client is handed the truth in the same
response that refuses it, so telling the user who won costs no extra round trip.

`@QueryBudget(2)` on the handler, not the service method — drill 08 established that `Reflector`
reads metadata off the controller's handler. Happy path is 1 statement; the conflict path is 2
(the failed `UPDATE`, then the re-read that distinguishes 409 from 404).

Also on the controller, **declared before `@Get(':id')`**:

`GET /conversations/agents` → `[{ id, name }]`, the memberships of the header's org, `LIMIT 50`.
Nest matches routes in declaration order, so `agents` declared after `:id` is shadowed — and
`ParseUUIDPipe` would turn it into a 400 rather than a 404, which is the confusing version. It
exists because "assign to **me**" needs a "me", and this repo has no auth.

`updateStatus()` gains `version = version + 1`. Any write to the row bumps the version, or a stale
assign token survives a status change. `assign()` bumps `updated_at` as well — an assignment is
activity, so leaving `updated_at` alone would make the inbox's sort key lie. The consequence is
real and gets recorded rather than hidden: the claimed row jumps to the top of an
`updated_at DESC` list, and drill 10's keyset cursor is already documented as immune to
insert-shift but not to a moving sort key.

`ConversationSummary` and `ConversationListItem` gain `version: number`, and every select list that
feeds them gains `c.version`.

### Tenancy

`assign()` and `listAgents()` go through `TenantDb.withOrg` with **no `org_id` in their SQL**, same
as the four methods below the banner comment in `conversations.service.ts`. RLS is what scopes
them. No new table, so `pnpm check:tenancy` needs no change — but it must still be run, because a
new endpoint reaching an org-scoped table is exactly what it exists to catch.

### Server Action and the UI

`apps/frontend/app/conversations/actions.ts` — `'use server'` at the top of the file.

```ts
export async function claimConversation(input: {
  id: string; orgId: string; assigneeId: string | null; version: number;
}): Promise<{ ok: true } | { ok: false; conflict?: Current; error?: string }>
```

It calls a new `assignConversation()` in `apps/frontend/lib/api.ts` rather than a bare `fetch` —
that module is where the org header, `x-request-id` and the W3C `traceparent` get attached, and a
hand-rolled fetch drops all three silently.

**What revalidates, and how narrow.** `refresh()` from `next/cache`, on both the success and the
conflict path, and nothing else.

- `revalidatePath('/conversations')` is the wrong tool here twice over. The page's data comes from
  an uncached `fetch` to Nest (Next 16 does not cache fetch by default), so there is no cache entry
  to invalidate; and the docs state it currently also causes *every previously visited page* to
  refresh on next navigation. It would be a wider hammer doing less.
- `revalidateTag` would need tags this app does not have, and its stale-while-revalidate profile
  deliberately skips the immediate re-render — which is precisely the re-render the loser needs.
- `refresh()` refetches the current route's RSC payload and nothing else. Next ships it in the same
  POST response as the action's return value, so the row converges and the message arrives in one
  roundtrip and one soft update. No full reload, no `router.refresh()` from the client, no refetch
  the application had to write.

Calling `refresh()` on the **conflict** path is the load-bearing half: the 409 body says who won,
but the *row* has to come from the server or the UI is trusting a payload instead of the truth.

`apps/frontend/app/conversations/conversation-list.tsx` — `useOptimistic` + `useTransition`:

```tsx
const rows = [...initialItems, ...appended];
const [optimisticRows, applyClaim] = useOptimistic(rows, reducer);
startTransition(async () => {
  applyClaim({ id, assigneeId: me, assigneeName: myName });
  const result = await claimConversation({ … });
  if (!result.ok) setConflict(result);
});
```

Three things about this file, and each is a real behaviour rather than a style choice:

1. **`useState(initialItems)` has to go.** Today the component seeds state from the prop once, so a
   router refresh would re-render the Server Component with the truth and the table would keep
   showing the lie. The fix is small and stays inside the existing component: `initialItems` becomes
   the live server-rendered first page and only *appended* pages live in `useState`. Rows loaded via
   load-more still do not converge on a refresh — stated in the drill as a gap, not papered over.
2. **The optimistic value reverts by itself.** It applies for as long as the transition is pending;
   when the refreshed render lands, `optimisticRows` falls back to `rows`. Nothing "undoes" the
   optimistic assignment — the honest description is that it expires.
3. **`setConflict` is a `useState` setter inside a transition, so React defers it** until the
   transition completes. That is the behaviour we want and it is not obvious: the message appears at
   exactly the frame the true row does, so the user never sees "you got it" and "you didn't" in two
   different paints.

`apps/frontend/app/conversations/page.tsx` — a `?me=<membershipId>` param with the agent list
rendered as links, the same zero-JS pattern as the existing sort and status navs, and the same
stub as `?org=`: there is no auth in this repo and the plan says so out loud rather than implying
a session exists. `me` and the agent's name are passed to `ConversationList`.

**Security, stated rather than assumed.** A Server Action is a public POST endpoint reachable
without going through the UI. This one authenticates nothing, because nothing in this repo does —
`?org=` and `?me=` are URL parameters. That is a recorded gap of the same family as `X-Org-Id`, not
an oversight introduced here, and the drill says so in `Honest gaps`.

### Instrument

`apps/backend/db/claim.mts`, run by `pnpm db:claim <fire|bench|race>` via the `scripts/measure.ts`
catalog. Copies `db/quota.mts`'s shape: `knob()` provenance, `serverArms()`, `record()`, asserts
and exits 1.

- **`fire`** — the DONE WHEN, over HTTP. One unassigned conversation, N concurrent claimers with
  distinct assignee ids. Asserts, per arm:
  - `optimistic` / `pessimistic`: exactly one 200, N−1 409s, zero 5xx, final `assignee_id` equals
    the winner's, `version` moved by exactly 1, peak in flight == CONCURRENCY.
  - `lww`: N 200s and one final assignee — the failing run that proves the bug.
- **`bench`** — the card's table. Claim/release churn on **one row** so successful writes keep
  being legal: each worker reads the row, claims it, and on success releases it; on 409 it re-reads
  and tries again. At `LEVELS=2,10,50` and both fixed arms, report attempts/s, **successful
  writes/s**, conflict rate, retries per successful write, and p50/p95/p99. Round-robin across arms
  and levels, not arm-blocked — drill 05's interleaving rule.
- **`race`** — two sessions, a controlled interleaving, no luck: both read version *v*, both write.
  Printed step by step on `lww` (silent loss) and on `optimistic` (one 0-row UPDATE), then the same
  interleaving against `FOR UPDATE`.

Knobs: `ORG_ID`, `REQUESTS`, `CONCURRENCY`, `LEVELS`, `ROUNDS`, `DURATION_MS`, `ONLY`. Every one
declared in the `scripts/measure.ts` catalog, or `pnpm check:arms` fails — and it will, because
that check exists for exactly this.

No new k6 script. The card's measurement is contention on **one row**, which is the instrument's
job; k6 drives URL patterns and has no database connection to reset a row between rounds.

### Tests

**Backend** — `apps/backend/test/assign.e2e-spec.ts`, following `quota.e2e-spec.ts`: `listen(0)`,
a fixture org, ~40 concurrent claims (enough to collide through a pool of ten, fast enough for a
suite). Cases: one winner and N−1 409s; the 409 body carries the true assignee and version; a stale
version is 409 while a correct one is 200; 404 for a missing row; 404 (not 403) for another org's
row; the release path; the arm is echoed so a measurement never has to guess.

Two new expected-red / expected-green runs, joining the five already documented in
`memory-bank/progress.md`:

```bash
pnpm db:test:lww          # ASSIGN=lww          — expected RED
pnpm db:test:pessimistic  # ASSIGN=pessimistic  — expected green
```

**Frontend** — Playwright, committed. This is the first test runner the frontend has ever had and
it closes `memory-bank/progress.md` known issue 1 for this page.

- `apps/frontend/playwright.config.ts`, `@playwright/test` in `apps/frontend/package.json`,
  `pnpm test:ui` at the root. Runs on the **host** against `http://localhost:3001`, matching the
  repo's existing split (`scripts/` runs on your machine, `apps/backend/db/` runs in the container).
  `pnpm exec playwright install chromium` is a documented setup step.
- `apps/frontend/e2e/assign-conflict.spec.ts` — the card's DONE WHEN as a test. Two browser
  contexts on `/conversations?org=N&me=A` and `?me=B`, both loaded before either clicks, so both
  hold the same version. A clicks, wins. B clicks, and the assertion is the whole drill: B's row
  shows **A's name**, a conflict message names A, and the page **did not navigate** — asserted by
  pinning a value into `window` before the click and finding it still there afterwards, which is
  what "no full reload" means operationally.
- Rows are located by conversation id, never by position: a claim bumps `updated_at`, so the row
  moves.

### Wiring

- `docker-compose.yml`: `- ASSIGN=${ASSIGN:-}` in the `nest_server` `environment:` list. A variable
  missing from that list is not forwarded at all, and `pnpm check:arms` is what catches it.
- `info.controller.ts`: `assign: ASSIGN` in the `arms` block, read from the resolved module
  constant, never a second `process.env` read.
- `package.json`: `db:claim`, `db:test:lww`, `db:test:pessimistic`, `test:ui`.
- `scripts/measure.ts`: the `claim` catalog entry.

### Documentation

- `plans/2026-09-08_drill-14-optimistic-locking.md` — this plan, written before any code, with
  predictions recorded **before** the measurements and a Results section filled in after.
- `drills/14-optimistic-locking.md` — the learning guide. **First file in `drills/`**, so the
  directory is created here. Required sections: `If you read nothing else` (with the diagram),
  `Is this production ready?`, `Honest gaps`, `What I'd do differently at 10x`, and — new this time
  and previously missed — a **Tech stack cheat sheet** covering what is new or relevant across
  SQL/Postgres, NestJS, Next.js, Node.js and React. Every number is accompanied by the command that
  produced it. The card's three WRITEUP questions get answered explicitly, including describing what
  the losing user sees and then either defending it as good UX or admitting it is not.
- The diagram: both throughput curves (optimistic and pessimistic, successful writes/s against 2,
  10, 50 concurrent claimers) on one chart, with the crossover marked — plus a sequence diagram of
  the two-agent race showing where the optimistic lie is told and where it expires.
- `memory-bank/history.md` — a `planned` line when the plan file lands, updated to `implemented`
  when it ships. `memory-bank/progress.md` — the two new expected test arms, the Playwright setup
  step, and any new known issue. `README.md` — the drill 14 row and any new command.

---

## Predictions, recorded before measuring

Written down so the drill can report which were wrong, which is the part worth reading.

1. The `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT 1` completes in well under a second on 2.5M
   rows, because Postgres 11+ stores the default in the catalog instead of rewriting the heap.
2. `lww` loses every concurrent claim but one, and every claimer gets a 200 — 0 conflicts reported,
   N−1 agents wrong.
3. At 2 concurrent claimers, optimistic beats pessimistic on successful writes/s: no lock waits,
   and conflicts are rare enough that the wasted round trips do not pay for the queueing.
4. At 50, pessimistic wins: optimistic's conflict rate goes past ~80%, so most of its round trips
   produce nothing, and each conflict costs a re-read before the retry.
5. The crossover lands somewhere around 10 concurrent claimers on one row — stated as a guess, and
   the bisect is what settles it.
6. Optimistic's **latency** looks better than pessimistic's at every level, including the ones where
   its throughput is worse, because a fast failure is fast. Reading p99 alone would pick the wrong
   arm.

---

## Verification

Order matters — the schema change has to land before anything reads `version`.

```bash
pnpm docker:up && pnpm db:migrate
```

```bash
ASSIGN=optimistic docker compose up -d nest_server && pnpm arms
```

Server half, the DONE WHEN — the first exits 1 and is the proof, the second exits 0:

```bash
ASSIGN=lww docker compose up -d nest_server && pnpm db:claim fire
```

```bash
ASSIGN=optimistic docker compose up -d nest_server && pnpm db:claim fire
```

The suite, including the two new arms — `db:test:lww` is expected **red**:

```bash
pnpm db:test && pnpm db:test:lww; pnpm db:test:pessimistic
```

The UI half, in a real browser, two contexts, no reload:

```bash
pnpm exec playwright install chromium && pnpm test:ui
```

The table the card asks for, both arms at 2, 10 and 50 on one row:

```bash
pnpm db:claim bench --levels 2,10,50 --rounds 3 --name drill14-final
```

The mechanism, deterministically, with no luck involved:

```bash
pnpm db:claim race
```

Wiring and tenancy — both must pass before the PR:

```bash
pnpm check:arms && pnpm check:tenancy && pnpm typecheck && pnpm format && pnpm lint
```

Then by hand, because a passing Playwright run is not the same as having watched it: two browser
windows on `/conversations?org=1&me=<A>` and `?me=<B>`, both loaded, both claiming the same row,
screenshots of what the loser sees. Those screenshots go in the drill.

Finally: commit in chunks (schema → endpoint → instrument → UI → tests → docs), then
`gh pr create` against `main`. No release tag and no version bump in this pass — the card asked for
a PR, and cutting `drill/14` is a separate step after the merge.
