#!/usr/bin/env sh
set -eu

if [ "${CLAUDE_PRECOMMIT_SKIP:-0}" = "1" ]; then
  echo "Claude pre-commit review skipped by CLAUDE_PRECOMMIT_SKIP=1."
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude CLI was not found on PATH."
  echo "Install Claude Code or skip with CLAUDE_PRECOMMIT_SKIP=1 git commit ..."
  exit 1
fi

if git diff --cached --quiet --exit-code; then
  echo "No staged changes to review."
  exit 0
fi

max_bytes="${CLAUDE_PRECOMMIT_MAX_BYTES:-60000}"
budget="${CLAUDE_PRECOMMIT_MAX_BUDGET_USD:-0.25}"
model="${CLAUDE_PRECOMMIT_MODEL:-sonnet}"

diff_file="$(mktemp "${TMPDIR:-/tmp}/loctx-claude-precommit-diff.XXXXXX")"
response_file="$(mktemp "${TMPDIR:-/tmp}/loctx-claude-precommit-response.XXXXXX")"
trap 'rm -f "$diff_file" "$response_file"' EXIT HUP INT TERM

git diff --cached --find-renames --find-copies --diff-filter=ACMRT >"$diff_file"

actual_bytes="$(wc -c <"$diff_file" | tr -d ' ')"
if [ "$actual_bytes" -gt "$max_bytes" ]; then
  head -c "$max_bytes" "$diff_file" >"${diff_file}.truncated"
  mv "${diff_file}.truncated" "$diff_file"
  truncated="yes"
else
  truncated="no"
fi

{
  cat <<'PROMPT'
You are performing a blocking pre-commit review of a staged Git diff.

Review for:
- likely bugs and behavioral regressions
- security flaws or secret exposure
- unsafe file handling, path traversal, injection, or command execution risks
- broken packaging, imports, typing, tests, or CLI behavior
- maintainability issues that would be expensive to correct later
- violations of mature Python project practices

Rules:
- Be strict about correctness and security.
- Do not complain about style unless it affects correctness, safety, or maintainability.
- Do not request broad rewrites.
- Base findings only on the staged diff below.
- If the diff is too small to judge context, say so as a caution, not as a failure.
- The first line of your response must be exactly one of:
  RESULT: PASS
  RESULT: FAIL
- Use RESULT: FAIL only for issues that should block this commit.
- After the first line, include concise findings with file/path references when possible.

PROMPT
  echo "Diff truncated: $truncated"
  echo "Diff bytes reviewed: $(wc -c <"$diff_file" | tr -d ' ')"
  echo
  echo '```diff'
  cat "$diff_file"
  echo '```'
} | claude \
  --print \
  --output-format text \
  --no-session-persistence \
  --max-budget-usd "$budget" \
  --model "$model" \
  --tools "" \
  >"$response_file"

cat "$response_file"

first_line="$(sed -n '1p' "$response_file" | tr -d '\r')"
case "$first_line" in
  "RESULT: PASS")
    exit 0
    ;;
  "RESULT: FAIL")
    echo
    echo "Claude pre-commit review failed. Fix the findings or bypass intentionally with:"
    echo "  CLAUDE_PRECOMMIT_SKIP=1 git commit ..."
    exit 1
    ;;
  *)
    echo
    echo "Claude pre-commit review returned an invalid result header."
    echo "Expected first line: RESULT: PASS or RESULT: FAIL"
    exit 1
    ;;
esac

