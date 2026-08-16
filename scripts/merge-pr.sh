#!/usr/bin/env bash
# Merge gate for PRs (see #519): wait for every check on the PR to
# report, refuse to merge on any failure. `gh pr checks --watch
# --fail-fast` exits non-zero the moment a check fails, and `set -e`
# stops the merge. Merges once landed while the ci `verify` job was
# red or still pending; this script fails closed on both.
#
# Usage: scripts/merge-pr.sh <pr-number>
# (or:   pnpm run merge:pr -- <pr-number>)
#
# Server-side enforcement lives in
# .github/rulesets/main-requires-verify.json (apply via
# `gh api -X POST repos/{owner}/{repo}/rulesets --input <file>`);
# this script is the client-side belt-and-braces.
set -euo pipefail

# pnpm can forward the literal `--` from `pnpm run merge:pr -- <n>` as
# an argument of its own; tolerate it so both documented forms work.
if [[ "${1:-}" == "--" ]]; then shift; fi
pr="${1:?usage: merge-pr.sh <pr-number>}"

# Check runs are registered asynchronously after a push — polling too
# early yields "no checks reported", which must fail closed (it is NOT
# green), but deserves a grace period rather than an instant refusal.
echo "[merge-pr] waiting for checks to be reported on PR #${pr}..."
for _ in $(seq 1 30); do
  if gh pr checks "$pr" 2>&1 | grep -vq "no checks reported"; then break; fi
  sleep 10
done
if gh pr checks "$pr" 2>&1 | grep -qi "no checks reported"; then
  echo "[merge-pr] no CI checks appeared within 5 minutes — refusing to merge." >&2
  exit 1
fi

echo "[merge-pr] checks reported — watching until they settle..."
gh pr checks "$pr" --watch --fail-fast

echo "[merge-pr] checks green — merging."
gh pr merge "$pr" --squash --delete-branch
