#!/usr/bin/env bash
#
# From-source installer for loctx.
#
# Builds the workspace and exposes the `loctx` and `loctx-mcp` binaries on
# your PATH by symlinking the built entrypoints into a bin directory. The
# symlinks point at `dist/`, so a later `pnpm run build` is picked up with
# no relink. Re-run this script after moving or renaming the repo.
#
# Why not `pnpm link --global`? pnpm refuses to link packages that live
# inside a workspace (ERR_PNPM_LINK_BAD_PARAMS), and `pnpm setup` conflicts
# with a Homebrew/corepack-managed pnpm. Direct symlinks sidestep both.
#
# Usage:
#   ./scripts/install.sh                # pnpm install + build, then link
#   ./scripts/install.sh --no-build     # skip install/build, just (re)link
#   ./scripts/install.sh --uninstall    # remove the symlinks
#   LOCTX_BIN_DIR=~/bin ./scripts/install.sh    # override target dir
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${LOCTX_BIN_DIR:-$HOME/.local/bin}"

# bin name -> built entrypoint (kept as parallel arrays for bash 3.2 / macOS)
names=("loctx" "loctx-mcp")
sources=("$repo_root/apps/cli/dist/cli.js" "$repo_root/apps/mcp/dist/server.js")

do_build=1
do_uninstall=0

usage() { sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --no-build) do_build=0 ;;
    --uninstall) do_uninstall=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "loctx install: unknown option '$arg'" >&2; usage; exit 2 ;;
  esac
done

uninstall() {
  local i link target
  for i in "${!names[@]}"; do
    link="$bin_dir/${names[$i]}"
    # Only remove a symlink we own (one that points back into this repo).
    if [[ -L "$link" ]]; then
      target="$(readlink "$link")"
      if [[ "$target" == "$repo_root/"* ]]; then
        rm -f "$link"
        echo "removed $link"
      else
        echo "skipped $link (points outside this repo: $target)" >&2
      fi
    fi
  done
}

if [[ "$do_uninstall" == 1 ]]; then
  uninstall
  exit 0
fi

if [[ "$do_build" == 1 ]]; then
  echo "==> pnpm install"
  pnpm -C "$repo_root" install
  echo "==> pnpm run build"
  pnpm -C "$repo_root" run build
fi

# Fail early with a clear message if the build output is missing.
for src in "${sources[@]}"; do
  if [[ ! -f "$src" ]]; then
    echo "loctx install: missing build output '$src'." >&2
    echo "Run without --no-build, or run 'pnpm run build' first." >&2
    exit 1
  fi
done

mkdir -p "$bin_dir"
for i in "${!names[@]}"; do
  link="$bin_dir/${names[$i]}"
  ln -sf "${sources[$i]}" "$link"
  echo "linked ${names[$i]} -> ${sources[$i]}"
done

# PATH guidance: only nag if the target dir isn't already reachable.
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    echo
    echo "NOTE: $bin_dir is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$bin_dir:\$PATH\""
    ;;
esac

echo
echo "Done. Try: loctx --version"
