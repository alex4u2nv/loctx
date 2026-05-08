# loctx

Local-first code indexing and search service for MCP-capable coding agents.

This is a TypeScript / Node monorepo with three top-level concerns:

- **`packages/core`** — `@loctx/core`: the indexing engine. Discovery, filtering,
  chunking, embeddings, SQLite state, Chroma vectors, indexer, searcher,
  filesystem watcher.
- **`apps/cli`** — `@loctx/cli`: Commander CLI (`loctx index|search|status|...`).
- **`apps/mcp`** — `@loctx/mcp`: MCP stdio server exposing `search_workspace`,
  `workspace_status`, `refresh_workspace` to coding agents.
- **`apps/web`** — `@loctx/web`: Next.js admin / management UI.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## Quick start

```bash
npm install
npm run build      # builds @loctx/core, then the CLI + MCP

# CLI (smoke workflow)
npx loctx status
npx loctx index
npx loctx search "embedding identity guard"

# Next.js admin UI
npm run dev:web    # → http://localhost:3000
```

The first `loctx index` or `loctx search` downloads the default embedding
model (~90MB) into the Hugging Face cache; subsequent runs are fast.

## Configuration

Filtering rules live in `packages/core/src/data/filtering.yaml`. User overrides go in
`~/.loctx/config_overrides/*.{yaml,yml}` — alphabetical merge order, scalars
replace, lists extend, `remove_<key>` subtracts from the baseline.

Main config (`$XDG_CONFIG_HOME/loctx/config.yaml`) covers workspace roots,
embedding choice, and watcher tuning.

Storage:

- `$XDG_DATA_HOME/loctx/state.sqlite3` — file/chunk metadata (better-sqlite3)
- `$XDG_DATA_HOME/loctx/chroma/` — vector index

## Development

```bash
npm run typecheck     # tsc --strict across every package
npm test              # vitest, every package
npm run lint          # biome check
npm run verify        # lint + typecheck + test

npm run dev:cli -- status        # tsx-driven CLI
npm run dev:web                  # Next.js dev server
npm run dev:mcp                  # MCP stub
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
        chunking/, embeddings/, indexing/, retrieval/, storage/, watcher/
        data/filtering.yaml          # bundled defaults
        sql/state.sql                # named-section query file
      tests/
  apps/
    cli/                             # @loctx/cli  → bin: loctx
    mcp/                             # @loctx/mcp  → bin: loctx-mcp
    web/                             # @loctx/web  → next dev / next build
```
