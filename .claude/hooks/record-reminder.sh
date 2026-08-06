#!/usr/bin/env bash
# Stop hook. Nudges when *this session* changed source but never recorded to
# memory-bank/.
#
# Stop fires at the end of every assistant turn, not at session end, so the
# trigger is measured against the SessionStart snapshot rather than against a
# dirty working tree — otherwise a session resumed on top of uncommitted work
# nudges on turn 1, and a session that commits its work never nudges at all.
#
# Advisory: emits systemMessage, never blocks. A blocking Stop hook whose
# condition the model may not clear fires again on every subsequent stop.
# Rate-limited to one nudge per MB_COOLDOWN stops so it can recur late in a
# session without spamming every turn.

set -u
MB_COOLDOWN=5

payload=$(cat 2>/dev/null) || payload=''
root="${CLAUDE_PROJECT_DIR:-.}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mb-state.sh
. "$here/mb-state.sh" 2>/dev/null || exit 0

cd "$root" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

state_dir=$(mb_state_dir) || exit 0
sid=$(mb_session_id "$payload")
snap="$state_dir/snap-$sid"

# No snapshot (SessionStart didn't run, or a new session id): establish one and
# stay quiet. Nudging against an unknown baseline is worse than staying silent.
if [ ! -f "$snap" ]; then
  mb_snapshot > "$snap" 2>/dev/null
  exit 0
fi

{ read -r snap_head; read -r snap_src; read -r snap_mb; } < "$snap" 2>/dev/null || exit 0
now=$(mb_snapshot) || exit 0
head=$(printf '%s' "$now" | sed -n 1p)
src=$(printf '%s' "$now" | sed -n 2p)
mb=$(printf '%s' "$now" | sed -n 3p)

# Did this session do work? Either the source tree moved, or HEAD advanced.
worked=0
[ "$src" != "$snap_src" ] && worked=1
[ "$head" != "$snap_head" ] && worked=1
[ "$worked" -eq 1 ] || exit 0

# Was any of it recorded? Either memory-bank/ is dirty in a new way, or a
# commit made since the snapshot touched it.
recorded=0
[ "$mb" != "$snap_mb" ] && recorded=1
if [ "$recorded" -eq 0 ] && [ "$head" != "$snap_head" ] && [ "$snap_head" != none ]; then
  git diff --name-only "$snap_head..$head" -- memory-bank 2>/dev/null | grep -q . && recorded=1
fi
[ "$recorded" -eq 0 ] || exit 0

# Cooldown: count stops since the last nudge.
cd_file="$state_dir/cool-$sid"
n=$(cat "$cd_file" 2>/dev/null)
case "$n" in ''|*[!0-9]*) n=0 ;; esac
if [ "$n" -gt 0 ]; then
  printf '%s' "$((n - 1))" > "$cd_file" 2>/dev/null
  exit 0
fi
printf '%s' "$MB_COOLDOWN" > "$cd_file" 2>/dev/null

jq -n '{
  systemMessage: "This session changed source but nothing under memory-bank/. If the work is done, run the record step (CLAUDE.md step 5) while the context is still here."
}' 2>/dev/null || true

exit 0
