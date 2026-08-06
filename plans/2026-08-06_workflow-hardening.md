# Workflow hardening

**Status:** shipped

Six gaps found reviewing the `memory-bank/` + `plans/` + hooks setup on 2026-08-06. One theme runs through most of them: **reads are enforced by machinery, writes are enforced by hope.** The `SessionStart` hook guarantees the memory bank is loaded; nothing guarantees it is ever updated. That asymmetry is worse than a symmetric failure, because a stale memory bank still gets read confidently — the exact rot `SKILL.md` warns about.

## Problems

1. **The record step has no trigger.** Step 5 of `CLAUDE.md` depends on remembering at the end of a session, but sessions end by tab-close, context exhaustion, or a pivot to something else.
2. **Plan mode cannot write the plan file.** `Write` is blocked in plan mode, so `plans/YYYY-MM-DD_name.md` cannot be created where `CLAUDE.md` implies it is. Nothing says the file gets written immediately *after* approval, so the predictable outcome is an approved plan, an implementation, and an empty `plans/`.
3. **Competing memory stores.** The harness keeps its own project memory outside the repo and is instructed to file project facts there — the same facts `projectbrief.md` and `activeContext.md` hold. They split silently, and only one store is in the repo.
4. **Caps are documentation, not enforcement.** Nothing checks the 20/30-line limits. Appending is easier than pruning, and `activeContext.md` — the file loaded into every session — is the worst one to let bloat.
5. **None of it is tracked by git.** `.claude/`, `memory-bank/`, and `plans/` are untracked. One `git clean -fd` erases the system.
6. **The plan gate is absolute.** "Every feature, however small" makes a one-line fix trigger a planning stop. The friction trains the habit of skipping plans, which erodes the discipline the gate exists to enforce.

## Changes

**Hooks** (`.claude/settings.json`, scripts in `.claude/hooks/`)

- `Stop` → `record-reminder.sh`: fires when the working tree has source changes but `memory-bank/` has none. Non-blocking `systemMessage`, once per session via a session-keyed sentinel. Non-blocking is deliberate — a blocking Stop hook that keeps failing its own condition loops forever.
- `PreCompact` → warns that context is about to be lost and the memory bank is the only thing crossing the boundary.
- `PostToolUse` on `Write|Edit` → `memory-bank-cap.sh`: reports line count back to the model when a capped file exceeds its cap.

**Docs**

- `CLAUDE.md` step 2: state the real sequence — draft in plan mode, exit, write the plan file as the first action after approval, then implement. Scope the gate to work that spans multiple files, adds a dependency, or sets a pattern.
- `CLAUDE.md`: claim `memory-bank/` as the sole project memory store for this repo.
- `SKILL.md`: same plan-file timing rule; note that the caps are hook-backed.

**Git**

- `.gitignore` gets `.claude/settings.local.json`; everything else committed.

## Non-goals

- Blocking enforcement. Every hook here is advisory. A `PreToolUse` gate that refuses edits without a plan file would break trivial work and get disabled within a week.
- Making the harness memory store and `memory-bank/` interoperate. One wins; it's `memory-bank/`.
