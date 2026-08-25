---
name: memory-bank
description: Maintain a compact, decision-grade Memory Bank. Use at the start of any non-trivial task, when asked for project state or a memory update, and after a significant implementation.
---

# Memory Bank

Read all four files before a non-trivial task. The bank is a working set, not a transcript of
engineering work. Its job is to let a new session choose the correct next action quickly.

## File ownership and budgets

| File | Owns | Target |
| --- | --- | --- |
| `projectbrief.md` | Goals, non-goals, scope | 250 words |
| `techContext.md` | Current architecture and durable constraints | 3,500 words |
| `progress.md` | Current state, next action, live validation, open decisions | 1,500 words |
| `history.md` | Chronological plan index | 300 words per row |

Treat a budget as a limit. If a new fact would exceed it, replace a stale fact or compress an
existing entry first. Do not add a fifth file merely to evade these limits.

## The admission test

Add a line only if all are true:

1. A future session cannot cheaply recover it from code, tests, Git, or its linked plan.
2. It changes a future decision, implementation, or validation step.
3. It has one clear owning file and is stated as a fact, constraint, or unresolved decision.

Otherwise, leave it out. Test counts, browser-playthrough narration, file inventories, function
signatures, implementation chronology, and generic summaries fail this test. Link to the plan
or code location if that detail may later matter.

## Writing rules

- One fact has one home. Never restate a history row in `techContext.md`, a technical contract
  in `progress.md`, or a plan's detailed reasoning anywhere in the bank.
- Prefer a short invariant with its consequence: “Mode C uses two STT passes; price both before
  the first request.” Do not record the story of discovering it.
- Keep only current contracts in `techContext.md`. Move superseded choices out.
- Keep only actionable, unresolved information in `progress.md`. When resolved, promote one
  durable constraint to `techContext.md` if needed, then remove the progress item.
- `history.md` is chronological. Each row records date, plan link, outcome, status, and at
  most one non-obvious enduring constraint; it must stay under 300 words. The linked plan
  holds the detail. Compact old rows when they exceed the limit, without changing the outcome.
- Record unknowns explicitly as `_Not yet established._`; never promote an inference to fact.
- Never record secrets, values from `.env`, or private audio/recording data.

## Update protocol

After a significant implementation, update only the files whose owned facts changed:

1. Update the active next action or validation gap in `progress.md`.
2. Add or replace a durable contract in `techContext.md` only when it passes the admission test.
3. Add a `planned` history row when the plan is written; change only that row to `implemented`
   after its implementation lands.

On an explicit memory-bank update, review all four files, remove duplication and stale state,
and report only files that changed. Do not manufacture a next task or strategic direction:
propose it to the user when it is a judgment call.

At the end of every session, run a removal pass: delete stale, duplicated, superseded, or
non-actionable entries that fail the admission test. Preserve current decisions, constraints,
and unresolved validation gaps; do not add a summary merely to record the session.
