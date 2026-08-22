# loctx

[![CI](https://github.com/alex4u2nv/loctx/actions/workflows/ci.yml/badge.svg)](https://github.com/alex4u2nv/loctx/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](#install)

Local-first code indexing and search for MCP-capable coding agents.

## Quick start

```bash
npm install -g @loctx/cli   # or the prebuilt tarball — see Install below
loctx init                  # interactive: workspace roots, embedding model, port
loctx start                 # daemon: watcher + admin UI + MCP on one port
loctx setup-agent           # point your agents (claude, cursor, …) at it
```

The admin UI is at `http://localhost:<port>` (the port you picked in `init`; default 3022) and agents connect to `http://localhost:<port>/mcp`. First boot downloads the embedding model once (~90 MB); every boot after that runs offline — nothing leaves the machine. Optional: `loctx skills install` adds the bundled coding-quality skills to your user-level agent skills directory.

Four npm packages: `@loctx/cli` (the `loctx` binary — installs the rest), `@loctx/core` (indexing engine), `@loctx/mcp` (`loctx-mcp` stdio binary), `@loctx/web` (admin UI + HTTP server). The integrated daemon (`loctx start`) serves a Vite-built React admin UI and the MCP HTTP transport on one port via Hono.

[ARCHITECTURE.md](ARCHITECTURE.md) covers the design. [docs/MCP.md](docs/MCP.md) covers client setup. [docs/PRIVACY.md](docs/PRIVACY.md) covers what stays local. [CONTRIBUTING.md](CONTRIBUTING.md) covers development. [CHANGELOG.md](CHANGELOG.md) covers releases.

## Install

### Pre-built release (recommended)

A self-contained tarball from [GitHub Releases](https://github.com/alex4u2nv/loctx/releases) — no build, no `npm install`, no compiler. You only need Node on PATH whose **major version matches** the release (the bundled native addons are ABI-specific).

```bash
# install, or re-run any time to update to the latest release
curl -fsSL https://raw.githubusercontent.com/alex4u2nv/loctx/main/scripts/install-release.sh | bash
loctx --version
```

Once installed, update any time with **`loctx update`** (it fetches the latest release for your platform and restarts the daemon) — or re-run the one-liner above.

The installer drops `loctx` into `~/.local/bin` (override `LOCTX_BIN_DIR`) and the runtime into `~/.local/share/loctx` (override `LOCTX_HOME`). Releases are tagged per platform + Node major (e.g. `darwin-arm64-node25`); it picks the matching asset and refuses a mismatch with a clear message. Behind a TLS-intercepting proxy, pass your CA: `LOCTX_CA_CERT=/path/ca.pem ... | bash` (and set `network.ca_cert` afterwards so the model download trusts it too).

### From npm

```bash
npm install -g @loctx/cli
loctx --version
```

Installs the CLI plus its dependency tree (`@loctx/core`, `@loctx/web`,
`@loctx/mcp`). The native modules (better-sqlite3, LanceDB, ONNX
runtime, tree-sitter) use prebuilt binaries for your Node ABI where
available and compile from source otherwise — the release tarball above
skips that entirely, which is why it stays the recommended path. The
standalone stdio MCP binary is `npm install -g @loctx/mcp`.

### From source (contributors)

This repo uses [pnpm](https://pnpm.io/) (>= 9). The fastest way to get it: `corepack enable && corepack prepare pnpm@9.15.9 --activate`.

```bash
git clone git@github.com:alex4u2nv/loctx.git
cd loctx
pnpm install
pnpm run install:local
```

`pnpm run install:local` builds every workspace and runs `npm install -g ./apps/cli ./apps/mcp`. npm symlinks the two local packages into its global bin directory (already on your PATH, with the right shims on Windows), so `loctx` and `loctx-mcp` work from anywhere. Remove them with `npm rm -g @loctx/cli @loctx/mcp`.

This from-clone path is for development. Because npm links the local directories, the binaries resolve against the workspace's `node_modules` — including the private `@loctx/web` build that `loctx start` loads at runtime. For distribution, use the pre-built release tarball above (which bundles the private web build and the native runtime); see [Releasing](#releasing).

If `npm i -g` fails with a permissions error, your npm prefix isn't user-writable. Set a user-level prefix (`npm config set prefix ~/.npm-global`, then add `~/.npm-global/bin` to PATH) or use a Node version manager (nvm, fnm, volta).

### Troubleshooting: native build behind a TLS proxy or firewall

`loctx` depends on `better-sqlite3`, a native module. On `pnpm install` it downloads a prebuilt binary (no compiler needed) for your Node ABI; 12.x ships prebuilds for Node 22, 24, 25, and 26. If the download is unavailable it falls back to compiling from source via `node-gyp`.

A corporate proxy or a tool like Socket Firewall that intercepts TLS will break both paths with:

```
prebuild-install warn install unable to get local issuer certificate
gyp ERR! stack FetchError: ... reason: unable to get local issuer certificate
```

The interceptor re-signs HTTPS with a root CA that Node doesn't trust — Node uses its own CA bundle and ignores the system keychain. Point Node at the trust store so the prebuilt binary downloads (still no compiler needed):

```bash
# macOS: export the keychain (incl. any corporate/Socket root CA) to a PEM
security find-certificate -a -p \
  /Library/Keychains/System.keychain \
  /System/Library/Keychains/SystemRootCertificates.keychain \
  > ~/.config/node-extra-ca.pem
export NODE_EXTRA_CA_CERTS=~/.config/node-extra-ca.pem
pnpm install
```

On Linux, point `NODE_EXTRA_CA_CERTS` at your org's root CA PEM. Alternatively, allowlist `github.com`, `objects.githubusercontent.com`, and `nodejs.org` in the interceptor so those downloads pass through unmodified. If you must, `NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm install` bypasses verification — insecure, and it defeats the point of a scanning firewall.

## Quick start

```bash
loctx config init               # scaffold a commented config
$EDITOR ~/.config/loctx/config.yaml
loctx start
```

Defaults: admin UI at `http://localhost:3022/`, MCP at `/mcp`, watcher live-indexing every change under `workspace_roots`. Port comes from `daemon.port`. There is no `--port` flag; change the value and `loctx restart`.

First boot downloads the embedding model (~90 MB) into the Hugging Face cache. Every boot after that runs offline.

`loctx --help` (or `loctx <subcommand> --help`) lists every command. `loctx doctor` checks health.

### Open-files limit (macOS)

The watcher uses [@parcel/watcher](https://github.com/parcel-bundler/watcher): one native subscription per project root (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows). macOS still ships a 256 file-watch budget per process, which fills fast on a multi-project workspace.

```bash
sudo launchctl limit maxfiles 10240 unlimited
```

Log out and back in. `loctx doctor` flags this. `loctx start --no-watch` is the workaround if you cannot raise it.

## MCP clients

[docs/MCP.md](docs/MCP.md) walks each supported client. Snippets:

```json
// stdio
{ "mcpServers": { "loctx": { "command": "npx", "args": ["loctx-mcp"] } } }

// HTTP (loctx start running)
{ "mcpServers": { "loctx": { "url": "http://localhost:3022/mcp" } } }
```

Both transports expose six tools: `search_workspace`, `workspace_status`, `find_usages`, `find_duplicates`, `find_literal`, `refresh_workspace`.

## Configuration

Layered, low to high: built-in defaults, `$XDG_CONFIG_HOME/loctx/config.yaml`, env vars (`LOCTX_DATA_DIR`, `LOCTX_CONFIG_DIR`, `LOCTX_EMBEDDING_PROVIDER`). The project-level `.loctx.yaml` layer was removed in favor of a single editable global config (admin UI handles it).

```yaml
workspace_roots:
  - ~/Workspaces

embedding:
  provider: huggingface-transformers
  model: Xenova/all-MiniLM-L6-v2
  normalize: true

watcher:
  debounce_ms: 500

daemon:
  port: 3022
  hostname: 127.0.0.1

reconciliation:
  run_on_start: true
  interval_seconds: 600
```

`loctx config show` prints the effective merged config with the source of each leaf. Storage paths resolve via [`env-paths`](https://github.com/sindresorhus/env-paths); see [docs/PRIVACY.md](docs/PRIVACY.md) for the table and uninstall procedure.

## Security model

loctx runs as **a local, single-user, no-auth daemon** by default. The HTTP server (admin UI + MCP `/mcp`) binds to `127.0.0.1` and a Host + Origin guard rejects cross-origin requests so a malicious webpage can't trigger destructive operations or read indexed source via DNS rebinding. Outbound network access is denied by default and opens only for explicit `loctx model download` invocations.

Two caveats to flag explicitly:

- **MCP results are untrusted input to your AI agent.** `search_workspace`, `find_usages`, and `find_duplicates` faithfully return whatever was in your codebase — including hostile comments, README text, or string literals that try to redirect the agent. If you index a repository you don't trust, treat its content the same way you'd treat any other untrusted text source for an LLM. loctx doesn't (and can't reliably) sanitise this for you.
- **External analyzer commands come from the global config only.** `analyzers.{lizard,semgrep,astGrep}.command` is honored from `$XDG_CONFIG_HOME/loctx/config.yaml`. The project-level config layer was removed entirely, so `cd hostile-repo && loctx index` can no longer swap `lizard` to an attacker-supplied binary.

Vulnerability reports go through [SECURITY.md](SECURITY.md), not public issues.

## Releasing

Build a self-contained tarball for the current platform + Node major and attach it to a GitHub Release:

```bash
pnpm run build
pnpm run release:build          # → release/loctx-<version>-<platform>-<arch>-node<major>.tgz
gh release create v<version> release/loctx-*.tgz
```

The tarball is the `pnpm deploy` output: the CLI plus the bundled `@loctx/{core,web,mcp}` and the full runtime `node_modules` **including already-built native binaries**, so users install with no compiler and no prebuild downloads. It's platform + Node-major specific — build on each target you support (a CI matrix when you open up). Users install/update via the one-liner in [Install](#pre-built-release-recommended).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Bugs and features go to [Issues](https://github.com/alex4u2nv/loctx/issues). Security goes through [SECURITY.md](SECURITY.md), not public issues.

## License

Apache-2.0. See [LICENSE](LICENSE).
