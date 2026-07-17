# loctx Architecture (Node)

## Purpose

`loctx` is a local-first code indexing and search service for MCP-capable
coding agents (Codex, Claude Code, Cursor, etc.). It indexes developer
workspaces into a persistent local retrieval store, exposes agent-friendly
search tools over MCP, and provides a Commander-driven CLI for setup,
indexing, diagnostics, and server startup.

The product should be boring to operate: explicit configuration, deterministic
indexing, debuggable scope resolution, local-only defaults, and clear
recovery commands.

## Architecture Principles

- Local-first: no network calls for embeddings, telemetry, or indexing
  unless the user explicitly configures them.
- Deterministic state: project, file, chunk, and embedding identities must
  be stable and inspectable.
- Component boundaries: CLI, MCP tools, indexing, retrieval, filtering,
  storage, and watching are separate modules with narrow interfaces.
- Agent-oriented output: search responses include paths, line ranges,
  snippets, scores, match reasons, and resolved scope.
- One writer: LanceDB and SQLite writes flow through a coordinated indexing
  path to avoid corrupting local state.
- Configurable but safe by default: generated files, dependencies, build
  artifacts, binaries, oversized files, and secrets are skipped unless
  explicitly included.
- Testable core: business logic lives behind classes/functions that can be
  tested without invoking Commander or MCP transports.

## Project Layout

pnpm workspaces monorepo. ESM-only TypeScript everywhere. Build with `tsc`,
test with vitest, lint+format with biome.

```text
loctx/                                  # workspace root (private)
  pnpm-workspace.yaml                   # packages: ["packages/*", "apps/*"]
  package.json                          # pnpm scripts (run, -r, --filter)
  tsconfig.base.json                    # shared compiler options
  biome.json                            # workspace-wide lint+format

  packages/
    core/                               # @loctx/core — engine library
      package.json
      tsconfig.json                     # extends ../../tsconfig.base.json
      vitest.config.ts
      scripts/copy-assets.mjs           # post-build: copy SQL + YAML to dist/
      src/
        index.ts                        # public API barrel
        _validate.ts                    # Validator + Spec
        config.ts                       # YAML config loader
        container.ts                    # buildRuntime() composition root
        models.ts                       # types (Project, EmbeddingIdentity, ...)
        paths.ts                        # XDG via env-paths
        discovery.ts                    # WorkspaceDiscovery + identity helpers
        filtering.ts                    # FilteringRules, ProjectFilter
        gitignore.ts                    # ignore-package wrapper
        data/filtering.yaml             # bundled filter defaults
        sql/state.sql                   # named-section query file
        sql/loader.ts                   # loadQueries()
        chunking/                       # base, prose (LineWindow), code, index
        embeddings/                     # base, local (HF transformers, lazy), registry
        indexing/indexer.ts             # ProjectIndexer pipeline
        retrieval/searcher.ts           # WorkspaceSearcher + scope resolution
        storage/state.ts                # better-sqlite3 + named queries
        storage/vectors.ts              # @lancedb/lancedb (embedded, lazy import)
        watcher/service.ts              # @parcel/watcher fs subscription → indexer
        watcher/registry.ts             # per-project pause/resume registry
      tests/

  apps/
    cli/                                # @loctx/cli — bin: loctx
      src/cli.ts                        # Commander entrypoint
    mcp/                                # @loctx/mcp — bin: loctx-mcp
      src/server.ts                     # @modelcontextprotocol/sdk over stdio
    web/                                # @loctx/web — Vite SPA + Hono server (private)
      vite.config.ts                    # client bundle
      client/                           # React SPA (status, projects, search, admin, …)
      server/                           # Hono API + /mcp + host/origin guard
      shared/contracts.ts               # wire types shared by client + server
```

## Runtime Components

### Configuration

`config.ts` owns config loading, validation, and defaults. The main YAML
config covers everything *except* filtering rules — those live in their own
YAML override directory (separate concerns, separate files).

Primary config path: `$XDG_CONFIG_HOME/loctx/config.yaml`.

```ts
export interface Config {
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly paths: StoragePaths;
  readonly embedding: EmbeddingConfig;
  readonly watcher: WatcherConfig;
  readonly source: string | null;
}
```

### Paths

`paths.ts` centralizes XDG path resolution via `env-paths`.

```text
$XDG_DATA_HOME/loctx/
  vectors/             # LanceDB (one Lance table per embedding identity)
  state.sqlite3        # better-sqlite3 (file/chunk metadata, identity registry)
  loctx.pid            # single-instance daemon lock (see daemon-lock.ts)
  logs/
```

### Discovery

`discovery.ts` detects projects under configured workspace roots and resolves
a `cwd` to the nearest `.git/` project root. Stable IDs derive from the
canonical absolute root path (SHA-256 truncated to 16 hex chars).

### Filtering

`filtering.ts` decides whether a path is eligible for indexing.

Inputs:
- bundled `data/filtering.yaml` baseline
- alphabetical override files in `~/.loctx/config_overrides/*.{yaml,yml}`
- `.gitignore` (project + global) — additive only; cannot un-ignore secrets

`FilterDecision` includes a stable reason code (`FilterReason` const-as-union)
so `loctx doctor` and `loctx status` can explain skipped files.

### Chunking

`chunking/` turns file content into line-addressable chunks.

- `LineWindowChunker` — fallback for prose/configs/unsupported languages.
- `TreeSitterCodeChunker` — AST chunking for supported languages
  (planned via `web-tree-sitter` — line-window is the M1 baseline).
- Stable chunk metadata: line range, chunk kind, symbols, content SHA.

### Embeddings

`embeddings/` isolates embedding providers from storage and retrieval.

- `EmbeddingProvider` interface
- `LocalEmbeddingProvider` uses `@huggingface/transformers` (ONNX-runtime,
  pure JS) — lazy-loads model on first use
- `FakeEmbeddingProvider` for tests (deterministic SHA-derived vectors)
- `embeddings/registry.ts` — the model registry: known local models with
  their dimensions and defaults, including the 2025-generation
  `gte-modernbert` and `EmbeddingGemma` entries. `config.ts` and the
  admin Models tab resolve model choices through it.

`EmbeddingIdentity` includes provider, model, dimension, and normalize flag.
The Lance table name derives from this identity to prevent mixed-dimension
data corruption; the StateStore independently records the (table → identity)
binding so reusing a directory with a different model raises
`CollectionIdentityMismatch` before the first write.

### Storage

Storage is split between SQLite state and a LanceDB vector index.

`storage/state.ts` (better-sqlite3) tracks projects, files, chunks, content
hashes, mtime/size, indexed_at, embedding identity, and per-file error state.

`storage/vectors.ts` (`@lancedb/lancedb`, native NAPI bindings, in-process
— no server) wraps LanceDB operations: `mergeInsert`-based upsert,
delete-by-file, delete-by-project, and cosine vector search with optional
SQL `WHERE` predicate pushdown for `project_id` / `language` filters.

### Indexing

`indexing/indexer.ts` coordinates discovery → filtering → chunking →
embedding → storage. Skip-if-unchanged via content_sha + embedding_identity.
Atomic per-file replace (delete-then-upsert). The indexer is the single
write path for both CLI indexing and (eventually) watcher updates.

### Retrieval

`retrieval/searcher.ts` owns search behavior. Modes will eventually include
hybrid / semantic / keyword / path / symbol; M1 implements semantic.

`SearchRequest` / `SearchResponse` types include resolved scope so callers
can show users which projects were searched.

### Watcher (M4)

`watcher/` keeps the index fresh during editing — one [@parcel/watcher](https://github.com/parcel-bundler/watcher) subscription per project root (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows), per-file debounce, delete/rename handling, periodic reconciliation with exponential backoff, graceful shutdown. The `WatcherRegistry` exposes per-project pause/resume to the CLI and web UI.

### MCP Server (M3)

`mcp/` will expose agent-facing tools through `@modelcontextprotocol/sdk`
over stdio.

Initial tools: `search_workspace`, `workspace_status`, `refresh_workspace`.

## Composition Root

`container.ts` wires dependencies. Avoid module-level singletons.

```ts
export interface Runtime {
  readonly config: Config;
  readonly state: StateStore;
  readonly vectors: VectorStore;
  readonly embeddings: EmbeddingProvider;
  readonly discovery: WorkspaceDiscovery;
  readonly rules: FilteringRules;
  readonly indexer: ProjectIndexer;
  readonly searcher: WorkspaceSearcher;
  close(): void;
}

export function buildRuntime(config: Config): Runtime;
```

## Commander CLI

Use `commander` for all user-facing commands. Keep handlers thin.

```text
loctx
  index [path]
  search <query> [--cwd] [--scope auto|project|subtree|all] [--limit N] [--language L]
  serve            # M3
  watch            # M4
  status
  doctor
  reset index | reset project <path>
```

## Tooling

- `typescript ^5.6` — strict + `noUncheckedIndexedAccess` +
  `verbatimModuleSyntax` + `exactOptionalPropertyTypes`
- `vitest` — unit + integration tests
- `@biomejs/biome` — formatter + linter (single tool)
- `tsx` — dev runner for `pnpm --filter <pkg> dev`
- ESM-only: `"type": "module"`, NodeNext resolution, `node:` prefix on
  built-ins, top-level await where useful

## Testing Strategy

Unit tests cover: config loading, path resolution, project discovery, filter
decisions, chunking behavior, identity generation, ranking helpers.

Integration tests cover: temporary workspace with two fake git projects,
indexing and querying, all four scope modes, file deletion and orphan
pruning, MCP tool response schemas (later).

Tests use `FakeEmbeddingProvider` and a tmp-dir StateStore + LanceDB table.

## Initial Implementation Order

1. Package skeleton, Commander CLI, config, and paths.
2. Discovery, filtering, identity, SQLite state, and LanceDB wrappers.
3. Chunking, embeddings, project indexing, and CLI search/status.
4. Retrieval ranking and evaluation fixtures.
5. MCP server and tools.
6. Watcher, reconciliation, pruning, and locking.
7. CI, docs, diagnostics, release packaging.
