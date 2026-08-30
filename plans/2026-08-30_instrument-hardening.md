# Instrument hardening — make a knob that does nothing fail loudly

**Status:** implemented (all three phases)

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

The forwarding half of this is superseded by 6.4: once the runner generates the `-e` flags, the
check reads the catalog instead of the `package.json` scripts. The reserved-name half is
unchanged.

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

### 6. A runner and a host/container split (phase 2)

Everything above is phase 1. This section is phase 2, shipped on the same branch. It exists
because phase 1 made one thing measurably worse and left another untouched.

`package.json` holds 48 scripts and 3,780 characters. Two families are 72% of that, and both are
one line copy-pasted:

| Family | Scripts | Chars | Worst |
|---|---|---|---|
| psql one-liners | 7 | 1,124 | `db:activity` 235, `db:reset` 194, `db:log:on` 186 |
| instrument invocations | 4 | 709 | `db:search` 219, `db:paging` 180 |

The psql family repeats `docker compose exec -T postgres_db sh -c 'psql -U "$POSTGRES_USER" -d
"$POSTGRES_DB"` — 84 characters — seven times, 588 characters of pure prefix. `CLAUDE.md`
restricts shell to one-liners inside `package.json`, and a 235-character `psql` call with
embedded SQL is not one. Phase 1 made the instrument half worse by adding
`GIT_SHA=$(git rev-parse --short HEAD)` and five to ten `-e` flags to each of four scripts.

`load:baseline` does this job for k6 in 24 characters, because it points at a `.mjs` runner. The
precedent is already in the tree and the `db:*` scripts never adopted it.

The knobs are also undiscoverable. There is no `--help`. `db:search` forwards eight knobs, but
`indexes` reads `ONLY` and `MAINTENANCE_WORK_MEM` while `writes` reads `ROWS` and `INSERTS` — the
`-e` list is the union across all four modes, so it tells the operator nothing. Subcommands
appear only in a usage string printed after you get it wrong.

#### 6.1 One invariant for the layout

```
scripts/              runs on your machine
  setup.sh
  measure.mjs         new — the four instruments
  psql.mjs            new — the seven psql one-liners
  check-arms.mjs      moved from apps/backend/db/

apps/backend/db/      runs in the container
  explain paging search bench-copy seed stats check-tenancy
  lib/ reports/
```

`check-arms.mjs` runs on the host today and says so in its own header, sitting beside
`check-tenancy.mjs`, which does not. Nothing can tell them apart without opening the file. The
move costs two lines in `package.json`; no file in `plans/`, `memory-bank/` or `drills/` names it
by path. Its `root` constant goes from `../../../` to `../`, and its `.env` path with it.

`k6/run-baseline.mjs` also runs on the host and stays where it is. It is cohesive with `k6/*.js`
and `k6/reports/`, and splitting it from them to satisfy a directory rule would cost more than
the rule is worth.

> **Superseded by 7.2.** The exemption was wrong. Stating an invariant and keeping one file
> outside it makes the invariant advisory, and the exemption's argument — cohesion with
> `k6/*.js` — is the argument for the *scripts*, not for the host-side runner that launches
> them. `k6/run-baseline.mjs` is now `scripts/load.mjs`.

#### 6.2 `scripts/measure.mjs`

It owns a catalog — instrument, its subcommands, and its knobs with flag name, environment name,
default, and a one-line description — and builds the `docker compose exec` line itself, the way
`k6/run-baseline.mjs` builds its `docker run`.

The command names do not change. `plans/` and `memory-bank/` hold 45 recorded `pnpm db:*`
reproduction commands, and this is the same reason 5 rejects a `DRILL_` prefix. `pnpm db:paging
depths` stays; only what sits behind it moves.

```json
"db:paging": "node scripts/measure.mjs paging"
```

709 characters across four entries becomes roughly 130.

Both spellings work, flags winning: `pnpm db:paging depths --org 150` and `ORG_ID=150 pnpm
db:paging depths` both run. Recorded commands stay valid and new ones are self-documenting.

Argument parsing is `parseArgs` from `node:util`. No CLI library is a direct dependency today —
`commander`, `yargs` and `minimist` are transitive deps of build tooling — and the builtin covers
positionals, typed options and defaults. It is the right choice rather than merely an adequate
one because it **rejects unknown flags**: `--orgg 150` fails with
`ERR_PARSE_ARGS_UNKNOWN_OPTION` before a query runs. Two implementation notes. Catch that error
and print the knob list, because its default message trails into confusing advice about `--`. And
do not put defaults in the `parseArgs` config: it returns configured defaults as though they were
supplied, which would destroy the `(env)`/`(default)` provenance 1 exists to print. Defaults stay
in `knob()`, inside the container.

Forwarding becomes generated rather than maintained. The runner emits `-e NAME=value` only for
knobs that have a value, from a flag or from the host environment. The bare `-e NAME`
pass-through disappears, and with it the empty-string hazard that made the `||`-not-`??` rule
load-bearing. Keep `||` in `knob()` anyway — it still guards a direct in-container run.

`apps/backend/package.json` loses four passthroughs. `explain`, `paging`, `search` and
`bench:copy` are one-line `node db/X.mjs` wrappers, so the runner execs
`docker compose exec -T -w /app/apps/backend nest_server node db/paging.mjs depths` directly.
`GIT_SHA` moves out of JSON into the runner, where `k6/run-baseline.mjs` already computes it with
`spawnSync('git', …)`.

Bare invocation prints the thing that is missing today:

```
$ pnpm db:paging
paging — offset vs keyset at depth

  depths       offset/keyset at 5 depths, N rounds each
  walk         cost of paging the whole list
  concurrent   both arms under concurrent load

knobs
  --org         1                    which org to measure
  --page-size   50
  --rounds      3
  --depths      1,10,100,1000,5000
  --max-pages   400                  walk only
  --name        (none)               labels the report directory
```

#### 6.3 `scripts/psql.mjs`

`db:migrate:status`, `db:reset`, `db:psql`, `db:log:on`, `db:log:off`, `db:log:status` and
`db:activity` become `node scripts/psql.mjs <name>`. 1,124 characters becomes roughly 250, and
the SQL moves somewhere it can carry a comment explaining why — `db:activity`'s `left(query, 140)`
and `pid <> pg_backend_pid()` currently have nowhere to be explained.

The script names do not change, so the 54 recorded `pnpm db:migrate`, `db:reset` and `db:log:*`
commands keep working. `db:psql` keeps its interactive TTY; the rest keep `-T`.

This part is separable. It is `package.json` hygiene rather than measurement, and phase 2 is
still coherent without it.

#### 6.4 `check:arms` retargets and shrinks

Check 2 walked root `package.json` → `apps/backend/package.json` → instrument source to ask
whether a human remembered a `-e` flag. The runner generates those flags, so that bug class stops
existing, and the check becomes catalog-versus-source in one file pair, in both directions: a knob
read but absent from the catalog is unreachable, and a catalog entry no instrument reads is a dead
flag. The second is a new catch. Checks 1 and 3 are unaffected.

`GIT_SHA` is the one knob the runner forwards without a catalog entry, because it computes it
rather than reading it. The check matches the run-record knobs by name anywhere in the runner —
the same crude test check 3 uses on the k6 runner, and it is stated here for the same reason: it
catches a rename that half-lands, not a name mentioned and unused.

### 7. The k6 side, on the same two arguments (phase 3)

Phase 2 left `k6/` exactly as it found it, which meant the branch shipped a layout invariant that
`k6/run-baseline.mjs` broke: a 186-line HOST script living in the directory reserved for what runs
in the container. The two k6 scripts had the other half of the problem — `messages-search.js` was
90% a copy of `conversations-baseline.js`, and said so in its own header.

#### 7.1 `k6/lib/scenario.js` — the method, once

`conversations-baseline.js` (148 lines) and `messages-search.js` (126) differed in the URL, one
knob, the summary's parameter line and two columns of the RESULT row. Everything else — the
warm-up/measure scenario split, the tagged sub-metric declarations, the thresholds, the
`summaryTrendStats` list, the p99 arithmetic, the SUMMARY_OUT dance — was duplicated verbatim.

That duplication is not the same as `db/`'s. The `db/` instruments have genuinely different timing
loops, which is why a shared *measurement* harness stays rejected there. These two scripts are the
same experiment against two URLs, stated as such in prose and enforced by nothing. Extracting the
method makes the claim true by construction. Each script is now a URL, a `params` string, and two
`columns`: 40 and 47 lines.

**Filenames do not change.** ~60 recorded report directories are named after them and four plans
cite those names. `pnpm load list` and `pnpm load search` are the short way in.

#### 7.2 `scripts/load.mjs`

`k6/run-baseline.mjs` moves to `scripts/`, where host scripts live, and takes the shape of
`scripts/measure.mjs`: a knob catalog, `parseArgs`, generated `-e` flags, `--help` per script.
What it loses is the hand-rolled env plumbing — nine `const X = process.env.X || '…'` lines and a
literal object built from them.

One deliberate difference from `measure.mjs`. There, a catalog default is **not** forwarded, so an
unset knob stays `(default)` in the header. Here it **is**: the report directory name is built from
`ORG_ID`/`VUS`/`PAGE`/`PAGE_SIZE`/`DURATION`, so the runner has to resolve them, and a k6 summary
prints values rather than provenance, so nothing is lost by sending them. The directory name format
is byte-identical to before, including the `page1` a search run carries.

Anything after `--` goes to `k6 run`, replacing the old trailing-args behaviour that `parseArgs`
would otherwise reject. A `.js` name not in the catalog still runs, with the common knobs only, so
a scratch script needs no entry.

`pnpm load:baseline` stays as an alias for `pnpm load list`: `README.md`, three plans and
`techContext.md` cite it. Same reasoning as the `db:*` names in 6.

#### 7.3 The default that is written twice, and the check for it

`lib/scenario.js` keeps its own `__ENV.VUS || '10'` defaults, because a k6 script has to be
runnable by hand, and `scripts/load.mjs` declares the same values in its catalog, because it builds
the directory name. Two copies of a default is precisely the bug class this branch exists to
close, so `check:arms` gained a third direction: it pairs `__ENV.X || 'v'` in `k6/` against
`env: 'X', def: 'v'` in the catalog and fails when they disagree, naming both values.

Check 3 also had to follow the knobs. It read `k6/*.js` at the top level only; every `__ENV` read
now lives in `k6/lib/scenario.js`, so it would have gone green while checking nothing — the same
failure the plan already records against `envReads`. It walks `k6/` now, skipping `reports/`, and
`envReads` gained `__ENV.X` as a third spelling so one scanner serves all three checks.

Note the asymmetry with `db/lib/`, which check 2 skips: `db/lib/run.mjs`'s knobs belong to the
instruments that import it, one of which may not. `k6/lib/scenario.js` is imported by every k6
script, so its knobs are charged to it directly.

#### 7.4 The load shape is the script's, the method is not

7.1 froze `options` into a finished object. That was one decision too many. It welded together two
things that are not the same:

- **The method** — the discarded warm-up, the tagged sub-metric declarations, `summaryTrendStats`
  for p99, the error assertion, throughput per measured second. This is what lets tonight's number
  be compared to one from eight weeks ago, so it is not the script's to change.
- **The load shape** — executor, VUs, duration, stages. A baseline wants `constant-vus`, a soak
  wants `ramping-vus`, an open-model test wants `constant-arrival-rate`. Freezing this made the
  module serve exactly one kind of experiment.

`scenario({ measure, warmup, thresholds })` takes the shape and wraps the method around it.
`scenario()` with no argument returns the flat baseline byte for byte, so the two existing scripts
changed by two lines each and every recorded run in `k6/reports/` stays comparable.

The part that needed care is the branch's own bug. A script declaring its own stages stops reading
`VUS` and `DURATION`, and labelling the summary from those knobs anyway would print
`vus=10 measured=60s` over a run that ramped to 200 for five minutes — correct percentiles under a
false header. So `shapeOf()` reads the measured window, the VU count and the throughput divisor off
the stage the script declared: stages sum their durations and report their peak target. Verified by
running a ramping script under `--vus 999 --duration 60s` and getting `vus=12 measured=8s` with
`42041 / 8 = 5255.13 req/s`.

Two things stay closed. `summaryTrendStats` and the two sub-metric names are the contract
`summary()` reads back by name, so a script cannot change them and silently break its own report;
script thresholds merge *under* the fixed three rather than over them.

Stated gap: the catalog still advertises `--vus` and `--duration` to every script. A script that
hard-codes its stages must drop them from its entry in `scripts/load.mjs`, or the help text
promises knobs that do nothing. Nothing checks this, because no script hits it yet — it is written
into `scenario()`'s own docstring where the next author will be standing.

## What does not change

- No benchmark framework, no adapter layer, no configuration DSL. The instruments measure
  different things and the long comment headers on `paging.mjs` and `k6/lib/scenario.js` are part
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

Phase 2:

| File | Change | Est. |
|---|---|---|
| `scripts/measure.mjs` | new — catalog, `parseArgs`, `docker compose exec`, help | +180 |
| `scripts/psql.mjs` | new — seven named queries | +90 |
| `scripts/check-arms.mjs` | moved from `apps/backend/db/`; check 2 retargets | ~ +20 / −45 |
| `package.json` | 11 scripts collapse; 3,780 chars → ~2,360 | ~ −1,420 chars |
| `apps/backend/package.json` | drop four passthrough scripts | −4 |

Phase 3:

| File | Change | Est. |
|---|---|---|
| `k6/lib/scenario.js` | new — the measurement method, once | +160 |
| `k6/conversations-baseline.js` | URL + summary line only | 148 → 40 |
| `k6/messages-search.js` | same | 126 → 47 |
| `scripts/load.mjs` | moved from `k6/run-baseline.mjs`; catalog, `parseArgs`, help | 186 → 265 |
| `scripts/check-arms.mjs` | check 3 walks `k6/`; `__ENV` spelling; default agreement | ~ +35 / −20 |
| `package.json` | `pnpm load`, `load:baseline` becomes an alias | +1 |

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

Phase 2, same red-then-green rule:

7. `pnpm db:paging` with no subcommand prints its subcommands and knobs, and exits non-zero.
8. `pnpm db:paging depths --org 150` and `ORG_ID=150 pnpm db:paging depths` produce the same
   `run.json`, with `knobs.ORG_ID` reading `150` and provenance `env`.
9. `pnpm db:paging depths --orgg 150` fails naming the unknown flag, before any query runs. This
   is the case no static check can reach today.
10. With no flag set, the header prints `ORG_ID 1 (default)`. Provenance survives the runner.
11. Add a catalog entry no instrument reads and `pnpm check:arms` fails on the dead flag; remove
    one an instrument does read and it fails on the unreachable knob.
12. `pnpm db:log:on && pnpm db:log:status && pnpm db:log:off` round-trips, and `pnpm db:psql`
    still opens an interactive prompt.
13. Every command in 1-6 above still runs verbatim.

Results. `package.json` went from 3,780 characters to 2,298 across the same 48 scripts; the
longest is now `docker:reset` at 124, where it was `db:activity` at 235, and 18 scripts over 80
characters became 7. `apps/backend/package.json` lost its four passthroughs. Bare `pnpm db:paging`
prints its three subcommands and six knobs; `--orgg 150` fails with `Unknown option '--orgg'`
before anything connects. `pnpm db:paging depths --org 1 --depths 1,10 --rounds 1` and
`ORG_ID=1 DEPTHS=1,10 ROUNDS=1 pnpm db:paging depths` wrote byte-identical `knobs` blocks, with
`PAGE_SIZE` and `MAX_PAGES` still reading `(default)` — the runner forwards nothing for a knob
nobody set, so provenance survives. Both new `check:arms` directions go red: a catalog entry no
instrument reads is named a flag that does nothing, and a knob removed from the catalog is named
unreachable. `pnpm db:log:on` / `:status` / `:off` round-trips −1 → 0 → −1. `pnpm db:test` 85/85,
`db:test:naive` still exactly 2 failed / 83 passed.

Phase 3, same red-then-green rule:

14. A knob added to `k6/lib/scenario.js` that `scripts/load.mjs` does not forward makes
    `pnpm check:arms` fail and name it. This is the check that would have silently stopped
    working when the `__ENV` reads moved into `lib/`.
15. Changing one k6 default so it disagrees with the catalog makes `check:arms` fail and print
    both values.
16. A knob named `TERM` in a k6 file fails on the reserved name, same as in `db/`.
17. `pnpm load list` and `pnpm load search` run end to end and write `run.json`, `summary.txt`
    and `dashboard.html` into a directory named exactly as before.
18. `pnpm load search --help` prints its knobs; `--orgg 150` fails naming the unknown flag.
19. `ORG_ID=1 VUS=2 … pnpm load:baseline` and the equivalent `--flag` form write identical
    `knobs` blocks.
20. `docker compose --profile test run --rm k6 run /scripts/conversations-baseline.js` still
    works with no runner at all, on the script's own defaults.

Results. The two k6 scripts went from 274 lines to 87, with the 160-line method extracted to
`k6/lib/scenario.js`. All three new `check:arms` directions go red on demand: an unforwarded
`__ENV.WARMUP_XYZ`, a `VUS` default of `'25'` against the catalog's `'10'`, and a `TERM` read.
`pnpm load list --name smoke-list --warmup 2s --duration 3s --vus 2` wrote
`k6/reports/2026-08-30-192344-smoke-list-conversations-baseline-org1-vus2-page1-size20-3s/`,
the same name shape as the 60 directories recorded before it, with `arms` and `gitSha` in
`run.json`. `pnpm load search` printed `q=ERR_2452 limit=20` and the RESULT row in the same
column order as before. The env-var and `--flag` forms produced byte-identical `knobs` blocks.
A hand-run through `docker compose run` produced `org=1 vus=2 page=1 pageSize=20`, matching the
catalog. `--quiet` after `--` reached `k6 run` and suppressed its progress bar. `pnpm format`
and `pnpm lint` green.

A review of phase 1 found five defects, fixed in `f0a17be`: `BACKEND_PORT` read on the host
without loading `.env`, which recorded `arms: null` in every k6 `run.json` without a word; the
compose slice keyed on the literal `next_app:` service name, so renaming that service would have
widened check 1 to every service below `nest_server`; an unguarded `response.json()` in
`pnpm arms`; no timeout on the k6 arm fetch; and `client()` reporting absent credentials as pg's
SASL error, which names nothing.

A review of the finished branch found four more, all of them the same shape the branch is about
— a number that is wrong while every signal around it says the run was fine:

- `seconds()` in `k6/lib/scenario.js` stripped a trailing `s` and called `Number()`, so
  `--duration 1m` — valid k6, valid at the runner — made throughput `NaN`. The p50/p95/p99 in
  the same block were correct, and the `NaN` went into the RESULT row. It now parses the whole
  k6 grammar (`1m`, `2m30s`, `1h30m`, `500ms`) and resolves at init, so a duration it cannot
  read fails the run instead of the summary.
- `knobNumber` and `knobList` in `db/lib/run.mjs` cast with a bare `Number()`. `--rows 100_000`
  — the underscore spelling the callers use in their own source — gave `NaN` while `header()`
  printed `BENCH_ROWS  100_000  (env)`. The provenance line existed to say the value arrived,
  and it was saying so above a run that measured nothing. Both now stop the run and name the
  value.
- `scripts/load.mjs` resolved knobs with `??` where `db/lib/run.mjs` documents `||`. An empty
  string from the shell beat the catalog default and dropped out, naming the report directory
  `-orgundefined-` while the container measured org 1.
- Check 3's default-agreement test looked each name up once in the whole of `scripts/load.mjs`.
  `PAGE_SIZE` is declared under both scripts, so a divergence in the second declaration passed
  green — verified. It is now driven from the catalog's declarations rather than the script's
  reads, so every declaration is compared. Check 2 avoids the same trap by slicing per block in
  `catalogFor()`; check 3 had not.

There is no A/B to run and no number to defend. The `/info` fetch and the file write sit outside
every timed region, which is a requirement on the implementation rather than a result to
measure.

## Honest gaps

- **The check knows only the knobs it can find.** It matches `process.env.X` reads in two
  directories. A knob read from an unusual place is invisible to it. This is the same limit
  `check-tenancy.mjs` states about `org_id`, and the same answer applies: the convention is
  written down because the checker depends on it.
- **A typo at the prompt is invisible, and 6 only half-fixes it.** No static check can see
  `ORGG=150 pnpm db:paging depths`, because an unknown environment variable is indistinguishable
  from the ambient environment. Once 6 lands, flags are checked and environment variables are
  not: `--orgg 150` is a hard error, `ORGG=150` still is not. The environment path survives only
  to keep the recorded commands running, so flags are the surface to recommend.
- **The catalog in 6 is a second place knobs are written.** It relocates the duplication from
  four `package.json` strings into one object that can be checked mechanically; it does not
  delete it. That is why 6.4 has to exist.
- **`/info` reporting configuration is a local-only affordance.** A real service should not
  publish its feature-flag state on an unauthenticated endpoint. This repo has no secrets in an
  arm name and no reader outside the laptop, so the trade is fine here and would not be fine in
  production. Worth saying in the drill rather than leaving as an implied pattern.
- **Run records accumulate.** `k6/reports/` already holds 60-plus directories and was pruned by
  hand once. `db/reports/` will need the same treatment. Automatic pruning is not proposed,
  because a deleted record is a deleted measurement.
- **The k6 default agreement check is textual.** It pairs a literal `__ENV.X || 'v'` against a
  literal `env: 'X', def: 'v'`. A default written as a computed expression, or a knob read
  somewhere other than `k6/lib/scenario.js`, is invisible to it. The convention is written down
  because the checker depends on it, same as the gap above.
- **Two copies of every k6 default still exist.** 7.3 makes disagreement fail loudly; it does not
  make one copy. The honest alternative — deleting the script-side defaults — costs the
  hand-runnability the k6 scripts are documented as having, and that trade was not worth making.
- **Nothing here catches drill 11's third and fourth defects.** One arm's count printed on the
  other arm's rows, and two rows timed by different methods under one header, are both errors
  inside an instrument's own reporting. No wiring check can see them. Review and a second pair
  of eyes remain the only defence, and the drill should say so instead of implying the checks
  cover the whole class.

## Sequencing

Phase 1, as decided at the time: the `drill-11` branch was unmerged and its head commit rewrote
`db/search.mjs`'s knobs and timing method. This plan touches `k6/run-baseline.mjs` and the `db/`
instruments, so landing it first guaranteed a conflict. `drill-11` merged first, and phase 1
landed against a tree that already contained `search.mjs`, bringing it into `lib/run.mjs` in the
same pass.

Phase 2 landed on the same branch, by decision rather than by default. Splitting it into a
follow-up would have left PR #8 shipping a `-e` forwarding check whose entire subject —
hand-maintained `-e` lists — the next PR deletes. The two are one argument, so they are one
branch.

Phase 3 landed on the same branch for the same reason. Phase 2 stated a layout invariant —
`scripts/` runs on your machine, the container directories run in the container — and
`k6/run-baseline.mjs` was a standing exception to it. Shipping the rule and its exception in one
PR and fixing the exception in the next would have made the rule read as advisory.

## Out of scope

- A shared **measurement** harness is still rejected: the timing loops differ, and forcing them
  into one shape trades validity for tidiness. A shared **invocation** runner is 6. This plan
  originally rejected both as one item, which is how `package.json` ended up holding 709
  characters of shell for four commands.
- **The reporting layer.** 57 hand-placed `padEnd`/`padStart` calls across three instruments,
  `search.mjs indexes()` at 178 lines, and `rows` in `run.json` populated for `db:paging` alone.
  Instruments returning rows to one shared renderer is a real change, and folding it into 6 would
  make that phase unreviewable. Deferred, not dropped.
- **Renaming the k6 scripts.** `conversations-baseline.js` and `messages-search.js` are long and
  the catalog aliases them to `list` and `search`, but ~60 recorded report directories embed the
  filename and four plans cite it. Renaming would split the record in two for a cosmetic gain.
- **The other 37 scripts.** Turbo, docker lifecycle, trace, and the four `db:test:*` arms. The
  test arms stay verbatim on purpose: `-e LIST_STRATEGY=naive` visible in the string is what makes
  the A/B legible at a glance.
- Re-running any past measurement. If a recorded number was produced through a knob that did
  not arrive, this plan surfaces the risk and does not settle it. Drill 09's conclusions were
  already re-checked after its `ORG_ID` defect and survived.
- A `CLAUDE.md` rule requiring write-ups to cite a run directory. That is worth doing and it is
  a workflow decision rather than an implementation one.
