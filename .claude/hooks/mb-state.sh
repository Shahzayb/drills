#!/usr/bin/env bash
# Shared helpers for the memory-bank hooks. Sourced, not run.
#
# State lives in a mode-700 per-uid directory so the sentinel/snapshot paths
# can't be pre-created or symlinked by another local user.

mb_state_dir() {
  local d="${TMPDIR:-/tmp}/claude-memory-bank-$(id -u 2>/dev/null || echo 0)"
  mkdir -p "$d" 2>/dev/null || return 1
  chmod 700 "$d" 2>/dev/null
  printf '%s' "$d"
}

# Session id, reduced to a safe filename component. Never empty.
mb_session_id() {
  local sid
  sid=$(printf '%s' "${1-}" | jq -r '.session_id // empty' 2>/dev/null | tr -cd 'A-Za-z0-9._-')
  printf '%s' "${sid:-nosession}"
}

# HEAD, then hashes of the source-side and memory-bank-side working tree.
# Three lines, stable format.
#
# Each hash covers `git status --porcelain` (catches adds/deletes, including
# untracked) *and* `git diff HEAD` (catches content). Status alone is not
# enough: editing a file that was already dirty at snapshot time leaves the
# porcelain line byte-identical, so the edit would read as "no work done".
mb_hash() {
  { git status --porcelain -- "$@" 2>/dev/null
    git diff HEAD -- "$@" 2>/dev/null
  } | shasum 2>/dev/null | cut -d' ' -f1
}

mb_snapshot() {
  local head src mb
  head=$(git rev-parse HEAD 2>/dev/null || printf 'none')
  src=$(mb_hash . ':(exclude)memory-bank' ':(exclude)plans')
  mb=$(mb_hash memory-bank)
  printf '%s\n%s\n%s\n' "$head" "${src:-x}" "${mb:-x}"
}
