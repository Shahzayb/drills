# Seed simplification — strip the Node-side micro-optimisation out of the drill-04 seeder

**Status:** implemented

## Result

**108.21s, against 108.2s / 109.7s before — no measurable cost.** `copy messages` landed at
78.32s against 78.4s before. All five fingerprints came back unchanged, so the seeder is
data-identical across 12.5M rows.

| | Before | After | Δ |
|---|---|---|---|
| `seed.mjs` | 506 | 446 | −60 |
| `lib/corpus.mjs` | 278 | 263 | −15 |
| total lines | 784 | 709 | −9.6% |
| **non-comment code** | **554** | **472** | **−14.8%** |

The code-line prediction (~475) was right; the raw-line one (~689) was ~20 lines optimistic,
because unwrapping the `if (opts.…)` blocks moved their justifying comments out to column 0
where they read better and got expanded rather than deleted. Fine trade, but worth recording
that the *comment* budget went up while code went down.

Three runs — **114.24s** (`copy messages` 82.33s), **108.21s** (78.32s), **109.61s** — against
drill 04's post-revision pair of 108.2s and 109.7s. Two of the three land on the old numbers
almost exactly.

The first run is the honest complication. It came *before* changes 4 and 5, which are zero-CPU
and cannot have made anything faster, so its 114.24s was noise rather than signal — **a single
measurement would have reported a 5% regression that does not exist.** Mean across the three is
~110.7s, perhaps 1–2s above the old mean, which is inside the ~3% band drill 04 recorded and
well under the 150s ceiling this plan set.

**The bench confirms the mechanism directly.** Template generation dropped from ~2M bodies/s to
**1,113,828/s** — the measured cost of deleting `compile()` — while Postgres ingests at
127,680 rows/s. Generation stayed **8.7× ahead** of the consumer, which is why 9.7s of CPU
bought ~0s of wall clock. That is the prediction this plan was built on, now measured rather
than argued.

## Context

`apps/backend/db/seed.mjs` (506 lines, ~344 of code) and `lib/corpus.mjs` (278, ~210 — most of
it the template corpus) seed 2.5M conversations and 10M messages in ~104–110s against a
6-minute budget. The speed is fine. The code is harder to read than the job warrants, and in a
teaching repo that *is* the defect.

Complexity and runtime turn out to be nearly uncorrelated here. Measured as seconds paid per
line of code removed, the exchange rate spans a factor of 40:

| Removing | Δ time | Lines out | s/line |
|---|---|---|---|
| **the Node-side micro-optimisation** | **+0–15s** | **~95** | **~0.12** |
| the index drop/rebuild | +11s | ~12 | ~0.9 |
| session tuning + the single transaction | +19s (with FK live) | ~18 | ~0.6 |
| the FK drop/re-add | +51s | ~10 | ~5.1 |

So the four SQL levers — dropping `messages_conversation_id_fkey`, the WAL-skipping
transaction, `maintenance_work_mem`, the index drop/rebuild — **all stay**. They are ~40 lines
of plain SQL, and they are also what drill 04 teaches; removing them would delete the drill,
not its complexity.

This finishes the job [drill 04](2026-08-11_drill-04-bulk-seed.md)'s own "Micro-optimisation,
measured and reverted" pass started. That pass reverted the three hot paths worth 0.12s and
kept the three worth 9.7s — but its argument for reverting, *the generator is not on the
critical path*, applies just as well to all six. It is the same mistake as the drill's headline
finding, one level further down.

**The architecture does not change.** Plan structure as plain objects → plan conversations into
five typed arrays → two generators yielding TSV every 10k rows → one transaction that
truncates, drops, COPYs, rebuilds, commits. That shape is right, and the typed arrays are
forced by the 1g container, not chosen for speed. This is five localized edits.

## CPU cost is not wall clock

The 3.8s / 5.5s / 0.38s figures below are **measurements**, taken in drill 04's revision pass.
What was never measured is how much of that CPU reaches the wall clock.

`Readable.from(generator)` is **pull-based**: the generator's `yield` does not resume until the
COPY stream asks for the next batch, so while Postgres writes the last 10k rows the generator
sits paused mid-function burning nothing. Hence drill 04's "suspended ~93% of the load".

For the messages phase, which dominates the load:

| | Node active | Node rate | Postgres rate | Headroom |
|---|---|---|---|---|
| now | ~5s of 73.3s | ~2M rows/s | 136k rows/s | 15× |
| after | ~13s of 73.3s | ~750k rows/s | 136k rows/s | 5.5× |

Node stays the fast side of the pipe; it would have to slow ~14× to become the bottleneck.

**Why it still isn't free:** Node and Postgres share one machine's cores, so 8 extra
CPU-seconds of JavaScript is 8 seconds of contention with Postgres's parallel workers. That is
the likeliest explanation for the ambiguous 73.3s → 78.4s drill 04's revision saw from a change
measuring 0.12s. **Expected: +0–10s, by contention rather than starvation.** Build order step 1
measures this rather than trusting it.

## The five changes

| # | File | Now | Becomes | CPU |
|---|---|---|---|---|
| 1 | seed.mjs | `HEX` table + 16-index `uuidHex()` | `buf.toString('hex', …)` + 4 slices | 0.38s |
| 2 | seed.mjs | `dayCache` Map + hand divmod + boolean param | `stamp()` / `stampSecond()` | 3.8s |
| 3 | corpus.mjs | `compile()`/`render()` parts-and-slots | one `.replace()` | 5.5s |
| 4 | seed.mjs | `opts` matrix: 5 flags, 5 conditionals, 7-line comment | deleted; `--scale` stays | 0 |
| 5 | seed.mjs | `structureText` + 3 near-identical COPY blocks | one table-driven loop | 0 |

**1 — `uuidHex`.** Drop the 256-entry `HEX` table and rewrite the function as
`buf.toString('hex', off, off + 16)` plus four slices.

**2 — timestamps.** The `dayCache` Map, `dayString()`, and `stamp()`'s hand-rolled h/m/s divmod
with its `truncateToSecond` boolean become two named one-liners over
`new Date(…).toISOString()`. Two names beat a boolean argument, and the truncation is **not**
redundant with `planConversations` — the `Math.max(…, Math.floor(created[i]))` branch can emit
a non-second-aligned value for conversations younger than the minimum span. Second granularity
is load-bearing: it manufactures the `updated_at` ties that drill 03's
`ORDER BY updated_at DESC, id DESC` tiebreaker exists for.

**3 — corpus.** Delete `compile()`, the `compiled` build loop, and `render()`. **Keep the
startup validation** — a bare `.replace()` would silently interpolate `undefined` where
`compile()` currently throws on an unknown slot name. That would be a regression disguised as a
simplification.

**4 — flags.** Remove the `--naive` / `--no-txn` / `--keep-indexes` / `--no-tuning` /
`--keep-fks` matrix, keeping only `--scale` and its validation, and unwrap the five
`if (opts.…)` blocks in `main()`. Drill 04's A–F attribution table is the record of what those
flags measured.

> **Caveat, found during implementation and worth stating plainly:** the original plan said the
> flag code "stays in git history if a later card wants to re-run it". **It does not** —
> `apps/backend/db/` has never been committed, so the whole seeder is untracked and this
> deletion is permanent. The *measurements* survive in drill 04's Writeup; the ability to
> re-run them does not, and re-adding the flags would mean rewriting them. Judged acceptable
> because the numbers are what later cards cite, but it is a harder deletion than the plan
> assumed.

**5 — structure COPYs.** `structureText` and the three near-identical phase blocks collapse
into one loop over `[name, rows, sql, format]` tuples. The batching those blocks avoid was
already pointless at 200 / 1,200 / 1,778 rows.

## What it buys

| | Before | After | Δ |
|---|---|---|---|
| `seed.mjs` | 506 | ~430 | −76 |
| `lib/corpus.mjs` | 278 | ~259 | −19 |
| **total lines** | **784** | **~689** | **−12%** |
| non-comment code | 554 | ~475 | −14% |

Only ~16 of the removed lines are comment — the micro-optimised regions are dense, not verbose.
Calibrate on this being a **12–15% reduction, not a rewrite**; the file is still ~430 lines.

The line count is the weakest measure. Two better ones:

**Mechanisms a reader must decode: 12 → 7.** What stays is `writeUuid`'s bit layout (inherent
to the uuidv7 spec), `uuidBuf`'s offset arithmetic (memory, and the fingerprint proof below),
typed-array planning (memory), the exact-shuffle skew and bucket residue patch (exact data
properties), the batched generator and its backpressure (the streaming design), and the four
SQL levers (the drill's subject).

The pattern in that list is the point: **afterwards, nothing in the seeder exists purely
because it was faster.** Every surviving piece of cleverness is justified by the uuid spec, the
1g memory ceiling, an exact-data property, or what drill 04 teaches. The lone exception is the
10k-line batching before each `yield`, which is structural to streaming. That gives a clean
rule for judging what belongs here in future.

**`main()` stops branching.** Losing five `if (opts.…)` blocks turns the load into one straight
line of ~14 statements. Probably the largest single readability gain, and it barely registers
in the line count.

## The invariant that makes this low-risk

**All five changes are fingerprint-preserving.** Same instants rendered as different text;
byte-identical hex; and `.replace()` with a global regex invokes its callback in the same
left-to-right slot order `render()` loops in, so the RNG draw sequence does not move.

So all five fingerprints recorded in drill 04's Determinism section must come back unchanged:
`26709482305` / `894726501` / `42058786904` / `−2209565241383` / `2014037425657`. That proves
the refactor is data-identical across 12.5M rows — far stronger than "the tests pass".

## Deliberately not done

- **The four SQL levers.** See the exchange-rate table above.
- **Removing `uuidBuf`, the 40MB shared Buffer.** The most tempting structural cleanup — it is
  the worst coupling in the file, threaded as a parameter through both generators — and it
  still stays. Deleting it means regenerating uuids in the messages pass from a split-out RNG,
  which shifts the `SEED+3` sequence, changes every `assignee_id`, and forfeits the fingerprint
  proof. One removed parameter is not worth that.
- **Typed arrays, exact-shuffle skew, message-bucket residue patch.** Forced by memory, or 6
  lines buying an exact property.
- **Splitting `seed.mjs`.** ~430 lines read top to bottom beats three files and more
  indirection.
- **`bench-copy.mjs`.** Not in the seed path, so it adds no complexity to the thing being run.
  It does import `createCorpus`, so change 3 must keep `pnpm db:bench` working.

## Build order

1. **Settle the CPU question first.** Apply changes 1–3, run `pnpm db:seed` at full scale, and
   record the **`copy messages` phase** time alongside the total — ~8.2s of the 9.7s lands
   there. Within drill 04's recorded ~3% noise band → the model holds. Materially worse → we
   know before any further work, and change 3 (5.5s, the largest single item) is first to
   revert.
2. Verify Postgres accepts `2026-08-11T03:08:00.123Z` in `COPY` text format. ISO 8601 is native
   so it should; fallback is `.replace('T', ' ')`.
3. Apply changes 4 and 5. Both are zero-CPU, so they carry no timing risk.
4. Full `pnpm db:reset`; fingerprints and timing.
5. Amend drill 04's plan: its revision table gains three more reverted rows, and step 1
   supplies the wall-clock column that table never had.

## Verification

- **Fingerprints** — `SELECT count(*), sum(hashtext(t::text)::bigint) FROM t` per table, all
  five matching. **This is the gate**: a mismatch means stop, not adjust.
- **Timing** — `pnpm db:reset` twice. Expected 110–125s. **Hard ceiling 150s**; past that,
  bisect rather than accept.
- **Per-phase timing**, not just the total — `copy messages` is what turns "slower" into an
  attribution, and it either confirms or kills the model above.
- **Integrity**, same assertions as drill 04's revision: zero rows after the `NOW` anchor, zero
  `updated_at < created_at`, zero messages outside their conversation's span, zero cross-org
  assignees, `convalidated = t`, all four sequences past `max(id)`.
- **Skew** — `GROUP BY org_id` still exactly 1,000,000 / ~111,111 / ~2,632.
- **`pnpm db:seed:ci`** (`--scale=0.1`) still gives exactly 250k / 1M.
- **`pnpm db:test`** — all 20 e2e tests.
- **`pnpm db:bench`** — still runs, since change 3 touches `createCorpus`.
