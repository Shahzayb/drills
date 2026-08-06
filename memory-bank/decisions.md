# Decisions

Append-only, newest first. Entries are never edited or deleted — a decision that no longer holds gets a **Superseded by** line pointing at the entry that replaced it, so the reasoning behind the original choice survives. That reasoning is the point: it's what stops the same question being relitigated a year later.

Read on demand. Before making a call that might already have precedent, `grep -i "<topic>" memory-bank/decisions.md`. Don't read the whole file on routine work.

---

## 2026-08-06 — `memory-bank/` is the only project memory store

**Why:** the Claude Code harness keeps its own per-project memory outside the repo and files "project" facts there by default — the same facts `projectbrief.md` and `activeContext.md` hold. Two stores holding one fact drift, and the reader can't tell which is current. `memory-bank/` wins because it's the only one in the repo: reviewable, diffable, shareable. Rejected: keeping both and cross-referencing (nothing enforces the cross-reference, so it decays to the same split). A redirect note lives in the harness store so future sessions route here.
**Plan:** `plans/2026-08-06_workflow-hardening.md`

## 2026-08-06 — Workflow enforcement is advisory, not blocking

**Why:** the hooks that guard the record step and the line caps emit messages; none refuse a tool call. Rejected: a `PreToolUse` gate blocking edits without a plan file, and a blocking `Stop` hook. Both fail the same way — a blocking `Stop` hook whose condition the model may not clear fires again on the next stop, forever, and a hard edit gate breaks trivial one-line work until someone disables the whole hooks block. An advisory nudge that gets read beats a hard gate that gets removed.
**Plan:** `plans/2026-08-06_workflow-hardening.md`

## 2026-08-06 — Backend on `3001`, frontend on `3000`

**Why:** so `pnpm dev` can run both apps at once without a port collision. Override syntax is in `techContext.md`.
