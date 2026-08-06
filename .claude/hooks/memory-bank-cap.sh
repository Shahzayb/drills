#!/usr/bin/env bash
# PostToolUse hook (Write|Edit). Enforces the line caps documented in
# .claude/skills/memory-bank/SKILL.md by reporting overflow back to the model.
#
# The caps exist so the files that churn stay small enough that pruning is
# obvious. Appending is always easier than pruning, so the cap needs a voice.

set -u

payload=$(cat 2>/dev/null) || payload=''
f=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -n "$f" ] || exit 0

# Resolve relative paths, then scope to this project — a memory-bank/ in some
# unrelated checkout is none of this hook's business.
root="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$f" in /*) ;; *) f="$root/$f" ;; esac
case "$f" in "$root"/*) rel=${f#"$root"/} ;; *) exit 0 ;; esac
[ -f "$f" ] || exit 0

case "$rel" in
  memory-bank/activeContext.md)  cap=20 ;;
  memory-bank/progress.md)       cap=30 ;;
  memory-bank/projectbrief.md)   cap=20 ;;
  memory-bank/productContext.md) cap=20 ;;
  *) exit 0 ;;
esac

# awk over wc -l: wc undercounts a final line with no trailing newline.
n=$(awk 'END{print NR}' "$f" 2>/dev/null)
case "$n" in ''|*[!0-9]*) exit 0 ;; esac
[ "$n" -gt "$cap" ] || exit 0

jq -n --arg name "$rel" --arg n "$n" --arg cap "$cap" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ($name + " is now " + $n + " lines, over its " + $cap + "-line cap. Cut what has stopped being load-bearing rather than leaving it long — this is the signal to prune, not to raise the cap.")
  }
}' 2>/dev/null || true

exit 0
