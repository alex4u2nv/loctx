#!/usr/bin/env bash
#
# Install a self-contained loctx release tarball (from a GitHub Release).
# No npm install, no build, no compile — the tarball already contains the
# runtime and its native binaries. You only need Node on PATH whose MAJOR
# version matches the tarball (the native addons are ABI-specific).
#
# Usage:
#   install-release.sh [path-or-URL-to-loctx-*.tgz]
#     - no argument: resolve and install the LATEST release for this
#       platform from GitHub (re-run any time to update).
#     - argument: install that specific tarball (path or URL).
#
# Env:
#   LOCTX_HOME      install root      (default: ~/.local/share/loctx)
#   LOCTX_BIN_DIR   where bins link   (default: ~/.local/bin)
#   LOCTX_REPO      owner/repo        (default: alex4u2nv/loctx)
#   LOCTX_CA_CERT   CA PEM for the download behind a TLS-proxy (optional)
#
set -euo pipefail

case "${1:-}" in
  -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
src="${1:-}"
home_dir="${LOCTX_HOME:-$HOME/.local/share/loctx}"
bin_dir="${LOCTX_BIN_DIR:-$HOME/.local/bin}"
repo="${LOCTX_REPO:-alex4u2nv/loctx}"

command -v node >/dev/null 2>&1 || { echo "loctx: Node.js is required but not found on PATH" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "loctx: curl is required but not found on PATH" >&2; exit 1; }

tag="$(node -p "process.platform+'-'+process.arch+'-node'+process.versions.node.split('.')[0]")"

# No tarball given → resolve the latest release asset for this platform.
if [[ -z "$src" ]]; then
  echo "resolving latest loctx release for $tag from $repo"
  src="$(
    curl -fsSL ${LOCTX_CA_CERT:+--cacert "$LOCTX_CA_CERT"} "https://api.github.com/repos/$repo/releases/latest" |
      node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const a=(r.assets||[]).find(x=>x.name.endsWith(process.argv[1]+'.tgz'));if(!a){console.error('no release asset matching '+process.argv[1]);process.exit(1)}process.stdout.write(a.browser_download_url)})" "$tag"
  )"
  [[ -n "$src" ]] || { echo "loctx: could not resolve a release for $tag" >&2; exit 1; }
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

tgz="$src"
case "$src" in
  http://* | https://*)
    tgz="$tmp/loctx.tgz"
    echo "downloading $src"
    curl -fSL ${LOCTX_CA_CERT:+--cacert "$LOCTX_CA_CERT"} -o "$tgz" "$src"
    ;;
esac

tar xzf "$tgz" -C "$tmp"
stage="$tmp/loctx"
[[ -f "$stage/loctx-release.json" ]] || { echo "loctx: not a loctx release tarball" >&2; exit 1; }

built_for="$(node -p "require('$stage/loctx-release.json').builtFor")"
if [[ "$built_for" != "$tag" ]]; then
  echo "loctx: this tarball was built for '$built_for' but you have '$tag'." >&2
  echo "       Native addons are platform + Node-major specific — grab the matching release," >&2
  echo "       or switch Node majors (nvm/fnm) to match." >&2
  exit 1
fi

ver="$(node -p "require('$stage/loctx-release.json').version")"
dest="$home_dir/versions/$ver"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
mv "$stage" "$dest"
ln -sfn "$dest" "$home_dir/current"

mkdir -p "$bin_dir"
node -e "const m=require('$home_dir/current/loctx-release.json');for(const[n,p]of Object.entries(m.bins))console.log(n+'\t'+p)" |
  while IFS=$'\t' read -r name rel; do
    ln -sfn "$home_dir/current/$rel" "$bin_dir/$name"
    echo "linked $name -> $home_dir/current/$rel"
  done

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo; echo "NOTE: $bin_dir is not on your PATH. Add: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo
echo "installed loctx $ver ($built_for). Try: loctx --version"
