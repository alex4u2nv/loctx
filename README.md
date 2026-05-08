# loctx (Node)

Local-first code indexing and search service for MCP-capable coding agents.
TypeScript / Node port of the loctx Python implementation.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## Smoke workflow (M1)

```bash
# 1. install + build
npm install
npm run build

# 2. show resolved config + discovered projects
npx loctx status

# 3. index the current working directory's project
npx loctx index

# 4. search — scope=auto resolves the nearest project from cwd
npx loctx search "embedding identity guard"
```

The first `loctx index` or `loctx search` invocation downloads the default
embedding model (~90MB) into the Hugging Face cache; subsequent runs are fast.

Filtering rules live in `src/data/filtering.yaml`. User overrides go in
`~/.loctx/config_overrides/*.{yaml,yml}` — alphabetical merge order, scalars
replace, lists extend, `remove_<key>` subtracts from the baseline.

Storage:

- `$XDG_DATA_HOME/loctx/state.sqlite3` — file/chunk metadata (better-sqlite3)
- `$XDG_DATA_HOME/loctx/chroma/` — vector index

## Development

```bash
npm run dev -- status      # tsx-driven dev mode
npm run typecheck
npm test
npm run lint
```
