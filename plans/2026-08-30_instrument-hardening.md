# Instrument hardening — make a knob that does nothing fail loudly

**Status:** implemented

## Context

Six instruments produce every number this repo cites: `db/explain.mjs` (642 lines),
`db/paging.mjs` (393), `db/bench-copy.mjs` (180), `db/check-tenancy.mjs` (173),
`db/stats.mjs` (117), and `k6/run-baseline.mjs` (119) driving `k6/conversations-baseline.js`.
Drill 11 adds `db/search.mjs` on the `drill-11` branch.

They share almost no code. Four of them build a `pg` client from the same five environment
variables, two define `median`, one defines a bar chart. That is roughly 30 duplicated lines
across 1,600. Duplication is not the problem and a shared benchmark harness would not fix the
problem.

The problem is that an instrument reports a number under a column header that describes a
different measurement. Eight recorded instances across five drills:

| Defect | Drill |
|---|---|
| `ORG_ID` was never forwarded through `docker compose exec`, so `ORG_ID=150 pnpm db:explain` measured org 1 for the whole of drill 09 | 09, found in 10 |
| `KEYSET_TIEBREAK` was missing from the compose `environment:` list, so the shell-set A/B ran the default arm twice | 10 |
| `QUERY_COUNTER=off` disabled the reporting and left the counting on | 08 |
| `TERM` collided with the terminal type every interactive shell exports, so `plans` compared two zero-match queries | 11 |
| `INSERTS` was not forwarded, and the header printed the default back as though the knob had arrived | 11 |
| One ILIKE match count was printed on the FTS rows as well, so those rows reported the other arm's answer | 11 |
| The control rows were timed by a different method than the rows beside them, under one `median ms` header | 11 |
| A README sentence joined a `pageSize=50` curl number to a `pageSize=20` k6 run | 08 |

Seven of the eight are the same bug wearing different hats: **a value the operator set did not
reach the code that branches on it, and nothing said so.** The eighth is a number retyped from
scrollback into prose.

Two instruments already carry the fix in comment form. `db/explain.mjs:68` and
`db/paging.mjs:37` both explain why they read knobs with `||` rather than `??`. The lesson is
written down five times across `plans/` and has never been enforced by anything that runs.

Drill 08 stated the rule this plan implements: **a measurement-arm switch needs a test that
fails when it stops switching.**

## What changes

### 1. A resolved-knob reader that distinguishes "set" from "defaulted"

New `apps/backend/db/lib/run.mjs`, beside the existing `db/lib/corpus.mjs`. Roughly 90 lines,
four exports.

`knob(name, fallback)` reads one environment variable with the `||` rule already documented in
two instruments, and records where the value came from. The run header then prints provenance
per knob, not just the value:

```
  org       150   (env)
  pageSize   50   (default)
  inserts   500   (default)   <- you set INSERTS=500 in the shell
```

Drill 11's `INSERTS` defect printed `inserts 500` from the default and read as success. The
`(default)` tag is the whole fix, it costs one word per line, and it makes a knob that did not
arrive visible before the run starts rather than after it finishes.

`client()` returns the one `pg` client built from the five Postgres variables, replacing four
copies. `median(values)` replaces two.

`record({ instrument, subcommand, rows })` writes the run to disk (see 4).

### 2. The server reports the arm it is actually running

`LIST_STRATEGY`, `KEYSET_TIEBREAK` and `QUERY_COUNTER` are resolved at module load in
`conversations.service.ts:216`, `conversations.service.ts:230` and `query-counter.ts:22`. An
instrument cannot see any of them, so a stale container looks exactly like a fresh one.

Extend the existing `GET /info` with an `arms` object. `InfoController` already exists and
already reports live state read through the pool, so no new module is warranted.

The values come from the resolved module constants, exported from where they are already
declared. They are not re-read from `process.env` inside the controller. That distinction is
the point: the endpoint must report the value the code branches on, and a second read of the
environment would agree with the shell while the running code disagreed.

Add `pnpm arms`, which prints that object. One command answers "what is the server running
right now", which is the question that would have ended drill 10's evening in a minute.

### 3. A check that fails when a knob is not forwarded

New `apps/backend/db/check-arms.mjs`, ~70 lines, following `check-tenancy.mjs` as precedent for
a script that fails the build on a fact about the running system.

Two assertions:

- **Forwarding.** Every arm switch read in `apps/backend/src/` appears in the `nest_server`
  `environment:` list in `docker-compose.yml`. Every knob read in `apps/backend/db/` appears in
  the `-e` flags of the root `package.json` script that invokes it. Either gap is drill 10's
  `KEYSET_TIEBREAK` and drill 11's `INSERTS`.
- **Reserved names.** A knob may not be named `TERM`, `PATH`, `HOME`, `USER`, `SHELL`, `LANG`,
  `PWD`, `EDITOR` or `PAGER`. Drill 11 lost a set of numbers to `TERM` alone.

This does not go into `check-tenancy.mjs`. That script answers whether the schema is protected,
this one answers whether the harness is wired, and merging them would produce a checker with
two unrelated subjects.

### 4. One run record per run, so numbers stop being retyped

Each instrument writes `apps/backend/db/reports/<stamp>-<instrument>-<sub>[-<name>]/` containing
`run.json` and `output.txt`. The directory name follows `k6/run-baseline.mjs`'s existing scheme,
so the repo has one convention rather than two.

`run.json` carries the instrument and subcommand, the timestamp, the git SHA, every knob with
its resolved value and its provenance, the server's `arms` object fetched from `/info`, and the
result rows the instrument already prints.

A plan or a drill then cites a run directory. Drill 08's README defect came from a number
retyped out of scrollback with its conditions left behind, and a cited directory carries the
conditions with the number.

### 5. Renaming the knobs is rejected

A `DRILL_` prefix on every knob would end the `TERM` class outright. It would also invalidate
every command printed in `plans/` and `drills/`, including numbers whose reproduction
instructions are the command line. The reserved-name denylist in 3 buys most of the safety for
none of that cost.

## What does not change

- No benchmark framework, no adapter layer, no configuration DSL. The instruments measure
  different things and the long comment headers on `paging.mjs` and `run-baseline.mjs` are part
  of what the drills teach.
- No change to what any instrument measures. Every recorded number stays comparable, and this
  plan produces no new measurement of its own.
- `seed.mjs` is untouched. It builds the fixture rather than measuring it.
- The prose headers stay as written. Where a header already explains the `||` rule, it gains a
  pointer to `lib/run.mjs` and loses the duplicated code underneath it.

## Files touched

| File | Change | Est. |
|---|---|---|
| `apps/backend/db/lib/run.mjs` | new — `knob`, `client`, `median`, `record` | +90 |
| `apps/backend/db/check-arms.mjs` | new — forwarding and reserved-name checks | +70 |
| `apps/backend/db/explain.mjs` | use `lib/run.mjs`, emit a run record | ~ +15 / −20 |
| `apps/backend/db/paging.mjs` | same | ~ +15 / −25 |
| `apps/backend/db/bench-copy.mjs` | same | ~ +10 / −10 |
| `apps/backend/db/stats.mjs` | use `client()` | ~ −8 |
| `apps/backend/src/info/info.controller.ts` | add `arms` | +15 |
| `apps/backend/src/conversations/conversations.service.ts` | export the two resolved constants | +2 |
| `apps/backend/src/observability/query-counter.ts` | already exports its constant, no change expected | 0 |
| `k6/run-baseline.mjs` | fetch `/info` arms, write `run.json` beside `summary.txt` | +20 |
| `package.json` | `pnpm arms`, `pnpm check:arms` | +2 |
| `apps/backend/test/*.e2e-spec.ts` | assert `/info` reports the arm the container was started with | +20 |

## Verification

Each check reproduces a recorded defect and must go red before the fix and green after.

1. **Drill 10's `KEYSET_TIEBREAK`.** Delete the line from the compose `environment:` list. Run
   `pnpm check:arms`. It must fail and name the variable. Restore the line, it must pass.
2. **Drill 11's `TERM`.** Add a knob named `TERM` to any instrument. `pnpm check:arms` must
   fail on the reserved name.
3. **Drill 11's `INSERTS`.** Run any instrument with a knob set in the shell but absent from the
   `-e` flags. The header must print `(default)` next to a value the operator set, and
   `pnpm check:arms` must fail.
4. **Drill 09's `ORG_ID`.** `ORG_ID=150 pnpm db:explain plans` writes a `run.json` whose
   `knobs.ORG_ID` reads `150` with provenance `env`.
5. **A stale container.** Start the server with `LIST_STRATEGY=naive`, then restart it without
   the variable. `pnpm arms` must report `batched` both times it is asked and must never report
   the shell's opinion.
6. `pnpm format`, `pnpm lint`, `pnpm db:test` green.

There is no A/B to run and no number to defend. The `/info` fetch and the file write sit outside
every timed region, which is a requirement on the implementation rather than a result to
measure.

## Honest gaps

- **The check knows only the knobs it can find.** It matches `process.env.X` reads in two
  directories. A knob read from an unusual place is invisible to it. This is the same limit
  `check-tenancy.mjs` states about `org_id`, and the same answer applies: the convention is
  written down because the checker depends on it.
- **`/info` reporting configuration is a local-only affordance.** A real service should not
  publish its feature-flag state on an unauthenticated endpoint. This repo has no secrets in an
  arm name and no reader outside the laptop, so the trade is fine here and would not be fine in
  production. Worth saying in the drill rather than leaving as an implied pattern.
- **Run records accumulate.** `k6/reports/` already holds 60-plus directories and was pruned by
  hand once. `db/reports/` will need the same treatment. Automatic pruning is not proposed,
  because a deleted record is a deleted measurement.
- **Nothing here catches drill 11's third and fourth defects.** One arm's count printed on the
  other arm's rows, and two rows timed by different methods under one header, are both errors
  inside an instrument's own reporting. No wiring check can see them. Review and a second pair
  of eyes remain the only defence, and the drill should say so instead of implying the checks
  cover the whole class.

## Sequencing

The `drill-11` branch is unmerged and its head commit rewrites `db/search.mjs`'s knobs and
timing method. This plan touches `k6/run-baseline.mjs` and the `db/` instruments, so landing it
first guarantees a conflict on that branch. Merge `drill-11` first, then land this against a
tree that already contains `search.mjs`, and bring `search.mjs` into `lib/run.mjs` in the same
pass.

## Out of scope

- A shared harness, runner abstraction, or plugin system.
- Re-running any past measurement. If a recorded number was produced through a knob that did
  not arrive, this plan surfaces the risk and does not settle it. Drill 09's conclusions were
  already re-checked after its `ORG_ID` defect and survived.
- A `CLAUDE.md` rule requiring write-ups to cite a run directory. That is worth doing and it is
  a workflow decision rather than an implementation one.
