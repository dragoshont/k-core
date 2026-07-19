#!/usr/bin/env bash
# Architrave — design<->code reconciliation gate. Regenerates platform code
# from the design tokens (config.tokenBuild) and reports drift vs committed code.
# Exit 0 = reconciled (or not applicable), 1 = DRIFT, 2 = error. Deps: jq, git.
set -uo pipefail
command -v jq >/dev/null 2>&1 || { echo "reconcile: 'jq' is required" >&2; exit 2; }

find_root() { local d="$PWD"; while [ "$d" != "/" ]; do [ -f "$d/architrave.config.json" ] && { printf '%s\n' "$d"; return 0; }; d="$(dirname "$d")"; done; return 1; }
root="$(find_root)" || { echo "reconcile: architrave.config.json not found" >&2; exit 2; }
cd "$root"
cfg() { jq -r --arg k "$1" '.[$k] // ""' architrave.config.json; }

if [ "$(cfg kind)" = "knowledge" ]; then
  echo "reconcile: UI design reconciliation not applicable for knowledge profile; skipping (PASS)"; exit 0
fi
tokens="$(cfg tokens)"; tokenBuild="$(cfg tokenBuild)"
if [ -z "$tokens" ] || [ -z "$tokenBuild" ]; then
  echo "reconcile: tokens/tokenBuild not configured — design<->code SSOT not wired yet; skipping (PASS)"; exit 0
fi
if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "reconcile: not a git work tree — run '$tokenBuild' and review changes manually; skipping"; exit 0
fi

before="$(git status --porcelain=v1 --untracked-files=all)"
echo "== regenerate from tokens: $tokenBuild =="
if ! eval "$tokenBuild"; then echo "reconcile: token build FAILED"; exit 2; fi
after="$(git status --porcelain=v1 --untracked-files=all)"

if [ "$before" = "$after" ]; then
  echo "reconcile: PASS — token generation produced no additional changes"
  exit 0
else
  echo "reconcile: DRIFT — token generation changed the worktree:"
  diff -u <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true
  echo "Fix: commit the generated output; or if the design legitimately changed, update tokens first, then regenerate."
  exit 1
fi
