# Changelog

[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Cuts from this set become the `0.1.x` line on npm.

### Added

- Tree-sitter chunkers for Python, JavaScript, TypeScript/TSX, Go, Rust, Java. Markdown section chunker. Line-window fallback.
- Hybrid retrieval: LanceDB vector + SQLite FTS5 lexical, fused via reciprocal rank fusion. Config-driven `retrieval.mode`.
- Analyzer metadata at indexing time: imports, exports, calls, paramCount, hasAsync, maxNestingDepth, maxLoopDepth, riskyCalls. Surfaces in `SearchResult` as `analyzer` + `matchReasons` (symbol_match, import_match, call_match, risky_call_category, complexity_signal, async_match, exported).
- Symbol cross-references graph (`symbol_refs`). MCP tool `find_usages` returns def + call/import sites with file/line jump targets.
- Reconciliation: boot pass + periodic timer catches drift after daemon downtime. Schema v4 adds `projects.last_reconciled_at`.
- Live filter reload: `.loctxignore`, `.gitignore`, `.git/info/exclude` changes prune matching chunks within one debounce window. Secret-glob baseline survives `.loctxignore` negation.
- CLI: `index`, `search`, `start`, `stop`, `restart`, `status`, `watch`, `doctor`, `model {current|use|download}`, `config {show|init}`, `reset {project|index}`, `init`.
- Integrated daemon: watcher, Vite + React admin UI, MCP HTTP transport on one port. Single-instance lock per data dir.
- Five MCP tools over stdio (`loctx-mcp`) and HTTP (`/mcp`): `search_workspace`, `workspace_status`, `find_usages`, `find_duplicates`, `refresh_workspace`.
- Admin UI: status, projects, search, find-usages, doctor, models, config, admin, plus SSE event stream. Per-project pause / resume / recrawl / purge controls with a derived health badge.
- Background analyzer enrichment queue (#61) with bounded concurrency, content-hash dedupe, per-task timeout. Opt-in adapters: Lizard complexity (#62), duplicate-code detection (#65), Semgrep + ast-grep rule packs (#64). Results surface in search and the admin UI.
- Concept/refactor coverage mode (#72) expands top hits with callers, importers, and siblings via the symbol cross-reference graph.
- Project discovery markers (#81) honour `.git`, IDE config dirs, and build-system roots with configurable extra markers.
- Per-project watcher controls: pause / resume / recrawl / purge via CLI (`loctx pause/resume/recrawl/purge`), HTTP API, and the projects page.
- Nested `.gitignore` honored across the project tree. Adds `.cursorignore`, `.aiderignore`, and `.ignore` (same syntax) — AI- and tool-aware ignore signals.
- Font Awesome icons across the management surfaces (watcher badge, action buttons, doctor status).
- Workspace path aggregation: longest common workspace prefix shown once as a header; per-row paths render the suffix only.
- Privacy guardrails: outbound network gate, trusted-models persistence, safe-log helper that scrubs absolute paths and chunk content.
- `loctx doctor` covers config, storage, embedding identity, retrieval mode, reconciliation, RLIMIT_NOFILE.
- Retrieval eval harness with 51 curated queries across 11 categories. Hit@5 sentinel ≥ 80%.
- End-to-end coverage: integration tests for daemon startup, scenario tests over real `Runtime` + in-memory MCP transport, Playwright e2e for the admin UI.
- CI: GitHub Actions runs `npm run verify` per push and PR.

### Changed

- Web stack: replaced Next.js with Vite + React (SPA) + Hono server. ~10× smaller install, faster cold start, no Webpack `Critical dependency` warnings. Embedded daemon mounts the built SPA + API + `/mcp` on `daemon.port` via `@hono/node-server`.
- Watcher: replaced `chokidar` with [`@parcel/watcher`](https://github.com/parcel-bundler/watcher). One native subscription per project root (FSEvents / inotify / ReadDirectoryChangesW) instead of pinning to chokidar 3's fsevents path.
- Default `daemon.hostname` is `127.0.0.1` (was `localhost`). Browsers don't rebind literal IPs.
- LanceDB writes serialise through a per-store mutex so the watcher + reconciler don't trip the "Too many concurrent writers" cap on workspaces with many active projects.
- Reconciliation runs on an exponential-backoff timer (`base × 2^N`, capped at 1h) instead of a fixed `setInterval` that retries failures every tick.
- `loctx model download <name> --use` switches `embedding.model` in the global config in the same command. Without `--use`, the CLI warns when the just-downloaded model isn't active.
- Development workflow switched from npm to **pnpm** (≥ 9). `pnpm-workspace.yaml` replaces the `workspaces` field; cross-workspace deps use `workspace:^` / `workspace:*`. CI + release workflows + lefthook + every doc updated. `pnpm` is required for builds (CONTRIBUTING.md has the `corepack` install snippet).
- Embedding-progress logs write to **stderr**, not stdout. Stdout is reserved for the JSONRPC channel when running as the stdio MCP server (`loctx-mcp`); any extra stdout write would corrupt the protocol mid-call.

### Fixed

- `NetworkBlockedError` names the specific model that triggered the block, so users don't run `loctx model download` for the wrong name (#140).
- Nested `.gitignore` rules now scope to their subdirectory; previously they were either silently dropped or applied workspace-wide.
- SSE heartbeat in `/api/events` no longer crashes the daemon when a client disconnects mid-tick.
- macOS `/var` vs `/private/var` symlink mismatch in `ProjectId` hashing. `realpathSync` in discovery and the searcher's path resolver.
- Concurrent first-callers no longer race `createEmptyTable` and throw "Table already exists"; `VectorStore.ready()` memoises the open Promise.

### Security

- Host + Origin guard middleware on every `/api/*` and `/mcp` request — rejects DNS-rebinding and CSRF attempts from any webpage the user visits. Static assets stay public.
- `analyzers.{lizard,semgrep,astGrep}.command` honored from the global config only; project-level `.loctx.yaml` overrides for these leaves are refused. Prevents `cd hostile-repo && loctx index` from swapping the binary.
- `stopActiveDaemon` verifies the lockfile's PID points at a `loctx` process (`ps -p`) before sending SIGKILL, refusing tampered lockfiles that aim the signal at another process.
- Outbound allowlist resets after `/api/models/download` finishes — never left open past the explicit user-triggered fetch.
- Privacy and security policy surface: [docs/PRIVACY.md](docs/PRIVACY.md), [SECURITY.md](SECURITY.md), and a "Security model" section in the README.
- Outbound network calls require per-process opt-in via the egress gate. Trusted-models persistence means the daemon does not re-prompt for downloaded models.

[Unreleased]: https://github.com/alex4u2nv/loctx/compare/main...HEAD
