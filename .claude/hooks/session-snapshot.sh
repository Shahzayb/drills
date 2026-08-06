#!/usr/bin/env bash
# SessionStart hook. Two jobs:
#   1. Inject memory-bank/activeContext.md (startup / clear / compact only —
#      on resume the transcript already carries it).
#   2. Record where the working tree stood when the session began, so the Stop
#      hook can tell work done *this session* from work already sitting there.

set -u

payload=$(cat 2>/dev/null) || payload=''
root="${CLAUDE_PROJECT_DIR:-.}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mb-state.sh
. "$here/mb-state.sh" 2>/dev/null || exit 0

if state_dir=$(mb_state_dir); then
  sid=$(mb_session_id "$payload")
  ( cd "$root" 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1 \
      && mb_snapshot > "$state_dir/snap-$sid" ) 2>/dev/null
fi

case "$(printf '%s' "$payload" | jq -r '.source // "startup"' 2>/dev/null)" in
  startup|clear|compact)
    jq -n --rawfile ctx "$root/memory-bank/activeContext.md" \
      '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}' 2>/dev/null || true
    ;;
esac

exit 0
