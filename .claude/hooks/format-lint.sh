#!/bin/bash
# Enforces CLAUDE.md: "Run pnpm format and pnpm lint before marking any task done."
# Runs only when there are uncommitted changes, so no-op turns stay fast.
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

if [ -z "$(git status --porcelain)" ]; then
  exit 0
fi

export NO_COLOR=1 FORCE_COLOR=0 CI=1
format_out=$(pnpm format 2>&1)
format_status=$?
lint_out=$(pnpm lint 2>&1)
lint_status=$?

if [ "$format_status" -ne 0 ] || [ "$lint_status" -ne 0 ]; then
  reason=$(printf '%s\n%s' "$format_out" "$lint_out" | sed -E $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' | tail -c 4000)
  jq -n --arg reason "$reason" '{decision: "block", reason: ("pnpm format / pnpm lint failed — fix before marking this task done:\n\n" + $reason)}'
fi

exit 0
