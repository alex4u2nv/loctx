#!/usr/bin/env bash
# Publish the loctx packages to npm in dependency order.
#
# Usage: scripts/publish-npm.sh [--otp <code>] [--dry-run]
#
# Idempotent: versions already on the registry are skipped, so re-running
# after a partial failure (expired OTP, missing scope, network) publishes
# only what's missing. Builds once at the root, then publishes with
# --ignore-scripts so all five publishes fit inside one OTP window.
set -euo pipefail

cd "$(dirname "$0")/.."

# Dependency order: mcp and web need core on the registry, cli needs
# core + web. Publish downstream last. (No unscoped alias: npm's
# similarity filter rejects the name `loctx` — too close to lolex/docx.)
PACKAGES=(packages/core apps/mcp apps/web apps/cli)

OTP_ARG=()
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    # pnpm run publish:npm -- --otp X forwards a literal "--"; ignore it.
    --) shift ;;
    --otp) OTP_ARG=(--otp "$2"); shift 2 ;;
    --otp=*) OTP_ARG=("$1"); shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "publish-npm: unknown arg: $1" >&2; exit 2 ;;
  esac
done

npm whoami >/dev/null 2>&1 || { echo "publish-npm: not logged in — run: npm login" >&2; exit 1; }

# Published artifacts must match a commit on main, not local edits.
[[ -z "$(git status --porcelain)" ]] || { echo "publish-npm: working tree not clean" >&2; exit 1; }

version=$(node -p "require('./packages/core/package.json').version")
for p in "${PACKAGES[@]}"; do
  v=$(node -p "require('./$p/package.json').version")
  [[ "$v" == "$version" ]] || { echo "publish-npm: $p is at $v, expected $version (run scripts/release-bump.mjs)" >&2; exit 1; }
done

echo "publish-npm: v$version — building once at the root (publishes skip scripts)"
pnpm run build

for p in "${PACKAGES[@]}"; do
  name=$(node -p "require('./$p/package.json').name")
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "publish-npm: $name@$version already on the registry — skipping"
    continue
  fi
  if $DRY_RUN; then
    echo "publish-npm: would publish $name@$version"
    continue
  fi
  echo "publish-npm: publishing $name@$version"
  (cd "$p" && pnpm publish --access public --ignore-scripts ${OTP_ARG[@]+"${OTP_ARG[@]}"})
done

echo "publish-npm: done — https://www.npmjs.com/settings/loctx/packages"
