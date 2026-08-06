#!/usr/bin/env bash
# Stop hook. Nudges when a session changed source but never touched memory-bank/.
#
# Advisory only — emits systemMessage, never blocks. A blocking Stop hook whose
# condition the model may not clear will fire again on the next stop, forever.
# Fires at most once per session (sentinel keyed on session_id).

set -u

payload=$(cat 2>/dev/null || echo '{}')
root="${CLAUDE_PROJECT_DIR:-.}"

cd "$root" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Source changed, memory bank didn't => the record step probably hasn't run.
changed=$(git status --porcelain -- . ':(exclude)memory-bank' ':(exclude)plans' 2>/dev/null)
recorded=$(git status --porcelain -- memory-bank 2>/dev/null)
[ -n "$changed" ] || exit 0
[ -z "$recorded" ] || exit 0

session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null)
sentinel="${TMPDIR:-/tmp}/claude-record-reminder-${session}"
[ -e "$sentinel" ] && exit 0
: > "$sentinel" 2>/dev/null

jq -n '{
  systemMessage: "memory-bank/ is untouched but the working tree has changes. If this session did real work, run the record step (step 5) before the context goes away."
}' 2>/dev/null || true

exit 0
