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
- Integrated daemon: watcher, Next.js admin UI, MCP HTTP transport on one port. Single-instance lock per data dir.
- Four MCP tools over stdio (`loctx-mcp`) and HTTP (`/mcp`): `search_workspace`, `workspace_status`, `find_usages`, `refresh_workspace`.
- Admin UI: status, projects, search, plus SSE event stream. Status page exposes daemon state, MCP client snippets, CLI commands.
- Privacy guardrails: outbound network gate, trusted-models persistence, safe-log helper that scrubs absolute paths and chunk content.
- `loctx doctor` covers config, storage, embedding identity, retrieval mode, reconciliation, RLIMIT_NOFILE.
- Retrieval eval harness with 51 curated queries across 11 categories. Hit@5 sentinel ≥ 80%.
- End-to-end coverage: integration tests for daemon startup, scenario tests over real `Runtime` + in-memory MCP transport, Playwright e2e for the admin UI.
- CI: GitHub Actions runs `npm run verify` per push and PR.

### Changed

- Pinned `chokidar` to `^3.6.0`. Chokidar 4 dropped fsevents and uses per-directory `fs.watch`, exhausting macOS file-watch budgets for multi-project workspaces. Chokidar 3 + fsevents collapses to one native FSEvents stream per project root.
- Embedding-progress logs write to stdout, not stderr. Stops Next.js dev mode from rendering them as errors.

### Fixed

- SSE heartbeat in `/api/events` no longer crashes the daemon when a client disconnects mid-tick.
- macOS `/var` vs `/private/var` symlink mismatch in `ProjectId` hashing. `realpathSync` in discovery and the searcher's path resolver.

### Security

- Privacy and security policy surface: [docs/PRIVACY.md](docs/PRIVACY.md), [SECURITY.md](SECURITY.md).
- Outbound network calls require per-process opt-in via the egress gate. Trusted-models persistence means the daemon does not re-prompt for downloaded models.

[Unreleased]: https://github.com/alex4u2nv/loctx/compare/main...HEAD
