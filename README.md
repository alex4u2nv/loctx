# loctx

[![CI](https://github.com/alex4u2nv/loctx/actions/workflows/ci.yml/badge.svg)](https://github.com/alex4u2nv/loctx/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](#install)

Local-first code indexing and search for MCP-capable coding agents.

Three publishable npm packages: `@loctx/core` (indexing engine), `@loctx/cli` (`loctx` binary), `@loctx/mcp` (`loctx-mcp` stdio binary). The integrated daemon (`loctx start`) serves a Vite-built React admin UI and the MCP HTTP transport on one port via Hono.

[ARCHITECTURE.md](ARCHITECTURE.md) covers the design. [docs/MCP.md](docs/MCP.md) covers client setup. [docs/PRIVACY.md](docs/PRIVACY.md) covers what stays local. [CONTRIBUTING.md](CONTRIBUTING.md) covers development. [CHANGELOG.md](CHANGELOG.md) covers releases.

## Install

This repo uses [pnpm](https://pnpm.io/) (>= 9). The fastest way to get it: `corepack enable && corepack prepare pnpm@9.15.9 --activate`.

```bash
git clone git@github.com:alex4u2nv/loctx.git
cd loctx
./scripts/install.sh
```

`scripts/install.sh` runs `pnpm install`, builds every workspace, and symlinks the `loctx` and `loctx-mcp` binaries into `~/.local/bin` (override with `LOCTX_BIN_DIR`). The links point at `dist/`, so a later `pnpm run build` is picked up with no relink; `./scripts/install.sh --uninstall` removes them. We symlink rather than `pnpm link --global` because pnpm won't link packages from inside a workspace.

If the script reports that the bin directory is not on your PATH, add it (e.g. `export PATH="$HOME/.local/bin:$PATH"`) and restart your shell.

`@loctx/web` stays private. The daemon needs the workspace's `apps/web/dist/{client,server}` build output, so run `loctx start` from a clone (or wait for an umbrella package).

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

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Bugs and features go to [Issues](https://github.com/alex4u2nv/loctx/issues). Security goes through [SECURITY.md](SECURITY.md), not public issues.

## License

Apache-2.0. See [LICENSE](LICENSE).
