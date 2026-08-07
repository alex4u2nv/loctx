#!/usr/bin/env bash
# Merge gate for PRs (2026-08-06 audit follow-up; see #519).
#
# GitHub-side required status checks need Pro (or a public repo), so
# until the repo goes public the gate lives in the merge path: wait for
# every check on the PR to report, refuse to merge on any failure.
# `gh pr checks --watch --fail-fast` exits non-zero the moment a check
# fails, and `set -e` stops the merge.
#
# The session that produced this had two merges land while the ci
# `verify` job was failing or still pending — both would have been
# stopped here.
#
# Usage: scripts/merge-pr.sh <pr-number>
# (or:   pnpm run merge:pr -- <pr-number>)
#
# When the repo goes public, apply .github/rulesets/main-requires-verify.json
# via `gh api -X POST repos/{owner}/{repo}/rulesets --input <file>` and
# this script becomes belt-and-braces rather than the only gate.
set -euo pipefail

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
