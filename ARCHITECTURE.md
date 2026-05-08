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
- One writer: Chroma and SQLite writes flow through a coordinated indexing
  path to avoid corrupting local state.
- Configurable but safe by default: generated files, dependencies, build
  artifacts, binaries, oversized files, and secrets are skipped unless
  explicitly included.
- Testable core: business logic lives behind classes/functions that can be
  tested without invoking Commander or MCP transports.

## Project Layout

ESM-only TypeScript with a `src` layout. Build with `tsc`, test with vitest,
lint+format with biome.

```text
loctx/
  README.md
  ARCHITECTURE.md
  package.json
  tsconfig.json
  biome.json
  vitest.config.ts
  src/
    index.ts                    # public API barrel
    cli.ts                      # Commander entrypoint
    container.ts                # composition root
    config.ts
    paths.ts
    models.ts
    discovery.ts
    filtering.ts
    gitignore.ts
    _validate.ts                # internal Validator + Spec
    data/
      filtering.yaml            # bundled defaults (shipped in package)
    sql/
      state.sql                 # named-section query file
      loader.ts                 # parseSqlFile()
    chunking/
      base.ts
      prose.ts                  # LineWindowChunker
      code.ts                   # TreeSitterCodeChunker (follow-up)
      index.ts                  # CompositeChunker / chunkFile
    embeddings/
      base.ts                   # EmbeddingProvider + FakeEmbeddingProvider
      local.ts                  # @huggingface/transformers (lazy)
      index.ts
    storage/
      state.ts                  # better-sqlite3
      vectors.ts                # chromadb
      index.ts
    indexing/
      indexer.ts                # ProjectIndexer
      index.ts
    retrieval/
      searcher.ts               # WorkspaceSearcher
      index.ts
    watcher/                    # M4
    mcp/                        # M3
  tests/
    unit/
    integration/
    fixtures/
```

## Runtime Components

### Configuration

`config.ts` owns config loading, validation, and defaults. The TOML config
covers everything *except* filtering rules — those live in YAML and are
loaded by the filtering layer (separate concerns, separate files).

Primary config path: `$XDG_CONFIG_HOME/loctx/config.toml`.

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
  chroma/
  state.sqlite3
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

`EmbeddingIdentity` includes provider, model, dimension, and normalize flag.
Chroma collection naming derives from this identity to prevent
mixed-dimension data corruption.

### Storage

Storage is split between SQLite state and Chroma vectors.

`storage/state.ts` (better-sqlite3) tracks projects, files, chunks, content
hashes, mtime/size, indexed_at, embedding identity, and per-file error state.

`storage/vectors.ts` (chromadb npm) wraps Chroma operations: upsert,
delete-by-file, delete-by-project, query.

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

`watcher/` will keep the index fresh during editing — `chokidar`-based file
events, per-file debounce, delete/rename handling, periodic reconciliation,
graceful shutdown.

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
- `tsx` — dev runner for `npm run dev`
- ESM-only: `"type": "module"`, NodeNext resolution, `node:` prefix on
  built-ins, top-level await where useful

## Testing Strategy

Unit tests cover: config loading, path resolution, project discovery, filter
decisions, chunking behavior, identity generation, ranking helpers.

Integration tests cover: temporary workspace with two fake git projects,
indexing and querying, all four scope modes, file deletion and orphan
pruning, MCP tool response schemas (later).

Tests use `FakeEmbeddingProvider` and a tmp-dir StateStore + Chroma client.

## Initial Implementation Order

1. Package skeleton, Commander CLI, config, and paths.
2. Discovery, filtering, identity, SQLite state, and Chroma wrappers.
3. Chunking, embeddings, project indexing, and CLI search/status.
4. Retrieval ranking and evaluation fixtures.
5. MCP server and tools.
6. Watcher, reconciliation, pruning, and locking.
7. CI, docs, diagnostics, release packaging.
