# loctx

Local-first code indexing and search service for MCP-capable coding agents.

This is a TypeScript / Node monorepo with three top-level concerns:

- **`packages/core`** — `@loctx/core`: the indexing engine. Discovery, filtering,
  chunking, embeddings, SQLite state, LanceDB vectors, indexer, searcher,
  filesystem watcher.
- **`apps/cli`** — `@loctx/cli`: Commander CLI. `loctx index|search|status|watch|start`.
- **`apps/mcp`** — `@loctx/mcp`: MCP stdio server (`loctx-mcp`) for agents that
  spawn the server as a child process.
- **`apps/web`** — `@loctx/web`: Next.js admin UI + MCP HTTP transport at `/mcp`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## Quick start

```bash
npm install
npm run build

# One command boots the watcher + admin UI + /mcp endpoint on a single port:
npx loctx start --port 3000

# → admin UI at http://localhost:3000/
# → MCP endpoint at http://localhost:3000/mcp
# → watcher live-indexing every file change under configured workspace_roots
```

The first `loctx start` (or `loctx index`) downloads the default embedding
model (~90MB) into the Hugging Face cache; subsequent runs are fast.

## Install

Two paths today.

### Local development install

```bash
git clone git@github.com:alex4u2nv/loctx.git
cd loctx
npm install
npm run build
npm link --workspace @loctx/cli --workspace @loctx/mcp
# → `loctx` and `loctx-mcp` are now on $PATH
```

The web app (`loctx start`'s admin UI) stays at the workspace path —
`@loctx/web` is a Next.js app, not a publishable library, so the daemon
needs the workspace's `apps/web/.next` build output. Run `loctx start`
from any directory; it locates the workspace via the linked binary.

### npm publish (planned, not yet shipped)

`@loctx/core`, `@loctx/cli`, `@loctx/mcp` are publish-prepped (`files`,
`publishConfig.access: public`, `prepublishOnly: npm run build`,
`engines.node >= 22`). Once the npm scope is claimed, the install becomes:

```bash
npm install -g @loctx/cli @loctx/mcp
```

`@loctx/web` stays private — the integrated daemon UI lives in the
workspace. A future top-level `loctx` umbrella package may bundle CLI +
MCP under a single global install. See GH#38.

## CLI subcommands

```bash
loctx start [--no-watch] [--no-web] [--replace]
    Run the integrated daemon: watcher + Next.js admin UI + /mcp on one port.
    Port and hostname come from `daemon.port` / `daemon.hostname` in config.
    Refuses to start when another daemon holds the data-dir lock; pass
    --replace (or use `loctx restart`) to take over.

loctx stop [--timeout 8000]
    Stop the running daemon for the configured data dir (SIGTERM, SIGKILL fallback).

loctx restart [--no-watch] [--no-web]
    Stop any running daemon for this data dir, then start a new one.

loctx index [path]
    One-shot index of a single project, or every discovered project when path is omitted.

loctx search <query> [--scope auto|project|subtree|all] [--limit N] [--language L]
    Search the local index from the terminal.

loctx watch [--path <project>]
    Headless watcher mode — reindex on every file change, no web/MCP. Logs events to stdout.

loctx config show
    Print the effective merged config with per-leaf source (default/global/project/env).

loctx config init [--project] [--force]
    Write a commented template to the global file (or to ./.loctx.yaml with --project).

loctx status
    Show resolved config, daemon state (PID, port, started-at), storage paths, and discovered projects.

loctx-mcp                  # separate binary
    MCP stdio server for agents that spawn the server as a child process.
```

## Admin UI

Once `loctx start` is running, visit `http://localhost:3000`:

- **`/`** — workspace status: config source, storage paths, embedding identity, discovered projects.
- **`/projects`** — per-project file counts, error counts, and last-indexed timestamp.
- **`/search`** — interactive search: query, scope, language, limit. Results render server-side.
- **`/mcp`** — MCP HTTP endpoint (Streamable HTTP transport). Not browser-friendly; agents only.
- **`/api/events`** — SSE stream of watcher events. The header dot turns green when connected;
  open admin pages auto-refresh on each change.

## Connecting MCP clients

### stdio (binary spawned as child process)

Configure your agent to launch `loctx-mcp` as the MCP server. Example for
Claude Code's MCP config:

```json
{
  "mcpServers": {
    "loctx": {
      "command": "npx",
      "args": ["loctx-mcp"]
    }
  }
}
```

### HTTP (integrated daemon)

If `loctx start` is running, point your client at the HTTP endpoint:

```json
{
  "mcpServers": {
    "loctx": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Both transports expose the same three tools: `search_workspace`,
`workspace_status`, `refresh_workspace`.

## Configuration

Layered, with later layers overriding earlier ones at the leaf level
(precedence low → high):

1. Built-in defaults
2. **Global** — `$XDG_CONFIG_HOME/loctx/config.yaml`
3. **Project** — `.loctx.yaml` discovered by walking up from `cwd` (opt-in
   by file existence; useful for pinning a model or daemon port per repo)
4. Environment — `LOCTX_DATA_DIR`, `LOCTX_CONFIG_DIR`,
   `LOCTX_EMBEDDING_PROVIDER`

There is no flag-level override layer. Per-invocation flags (`--scope`,
`--limit`, `--no-watch`, `--replace`, …) are operational, not config-mirrors.

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
  port: 3000
  hostname: localhost
```

Inspect or scaffold:

```bash
loctx config show              # effective merged config + source per leaf
loctx config init              # write a commented template to the global file
loctx config init --project    # ...or to ./.loctx.yaml in the current dir
```

Filtering rules live in `packages/core/src/data/filtering.yaml` (bundled
defaults). User overrides go in `~/.loctx/config_overrides/*.{yaml,yml}` —
alphabetical merge order, scalars replace, lists extend, `remove_<key>`
subtracts from the baseline.

Storage:

- `$XDG_DATA_HOME/loctx/state.sqlite3` — file/chunk metadata (better-sqlite3)
- `$XDG_DATA_HOME/loctx/vectors/` — LanceDB vector index (one Lance table per embedding identity)

## Development

```bash
npm run typecheck     # tsc --strict across every package
npm test              # vitest, every package
npm run lint          # biome check
npm run verify        # lint + typecheck + test

npm run dev:cli -- start         # tsx-driven daemon for development
npm run dev:web                  # Next.js dev server alone (admin UI without watcher/MCP)
npm run dev:mcp                  # stdio MCP binary
```

## Layout

```
loctx/
  package.json                       # workspace root (npm workspaces)
  tsconfig.base.json                 # shared compiler options
  biome.json                         # workspace-wide lint + format

  packages/
    core/                            # @loctx/core
      src/
        _validate.ts, config.ts, container.ts, discovery.ts, ...
        chunking/, embeddings/, indexing/, retrieval/, storage/
        watcher/{service.ts,bus.ts}  # filesystem watcher + event bus
        data/filtering.yaml
        sql/state.sql
      tests/

  apps/
    cli/                             # @loctx/cli  → bin: loctx
    mcp/                             # @loctx/mcp  → bin: loctx-mcp
    web/                             # @loctx/web  → next dev / next build
      app/
        layout.tsx                   # nav + live-refresh dot
        page.tsx                     # /  status
        projects/page.tsx            # /projects
        search/page.tsx              # /search
        mcp/route.ts                 # /mcp Streamable HTTP transport
        api/events/route.ts          # /api/events SSE stream
      components/live-refresh.tsx
      lib/admin-context.ts
```
