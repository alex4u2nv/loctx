/**
 * Wire types shared by the Hono server and the React SPA. No runtime
 * imports — keep this file dependency-free so both sides can pull it
 * without dragging in @loctx/core (which the client must not bundle).
 */

export interface StatusPayload {
  readonly daemon:
    | {
        readonly running: true;
        readonly pid: number;
        readonly hostname: string | null;
        readonly port: number | null;
        readonly startedAt: string;
        readonly version: string;
      }
    | {
        readonly running: false;
        readonly pidLockPath: string;
      };
  readonly runtime: {
    readonly configGlobal: string | null;
    readonly dataDir: string;
    readonly vectorDir: string;
    readonly stateDb: string;
    /**
     * On-disk size of the index in bytes: the LanceDB vector store
     * (`vectorDir`) plus the SQLite state DB and its WAL/SHM sidecars.
     * Best-effort; 0 if the paths can't be read.
     */
    readonly indexSizeBytes: number;
    readonly embeddingProvider: string;
    readonly embeddingModel: string;
    /** True once the embedding model has been initialized successfully. */
    readonly embeddingReady: boolean;
    readonly retrievalMode: string;
    readonly watcherDebounceMs: number;
    readonly reconciliationIntervalSeconds: number;
    readonly reconciliationRunOnStart: boolean;
  };
  /**
   * Live reconciliation state — non-null only while a pass is in
   * flight. The UI shows a banner during reconciliation so users know
   * search results may be incomplete.
   */
  readonly reconciliation: {
    readonly running: boolean;
    readonly startedAt: string | null;
    readonly currentProjectName: string | null;
    readonly completed: number;
    readonly total: number;
    /**
     * Files indexed so far inside `currentProjectName` (#44). Null until
     * the indexer reports progress or when idle. Pairs with
     * `currentProjectTotal` for "loctx: 86 / 219 files" mid-pass.
     */
    readonly currentProjectIndexed: number | null;
    readonly currentProjectTotal: number | null;
  };
  /**
   * Analyzer enrichment queue — backfill + reprocessing by lizard /
   * semgrep / ast-grep. `depth` > 0 means files are being (re)analyzed;
   * the projects page surfaces this so a slow backfill isn't invisible.
   */
  readonly analyzers: {
    readonly depth: number;
    readonly running: number;
    readonly completed: number;
    readonly failures: number;
    readonly lastRunAt: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly root: string;
  }>;
}

export type WatcherState = "active" | "paused" | "failed";

/**
 * Derived per-project health combining watcher state with index state.
 *
 *   - `failed`        watcher errored — needs investigation
 *   - `paused`        watcher manually paused
 *   - `never-indexed` files=0 && lastIndexed=null — needs initial rebuild
 *                     (the watcher only catches *changes*, not initial state)
 *   - `empty`         files=0 but lastIndexed!=null — filter excluded everything
 *   - `errors`        files>0 but some failed indexing
 *   - `indexing`      a rebuild is actively running for this project
 *   - `reconciling`   the daemon's reconciler is mid-pass on this project
 *   - `active`        watching + has data
 *   - `ready`         indexed, no watcher (daemon started with --no-watch)
 *   - `orphaned`      project no longer under workspace_roots
 *
 *   `indexing` + `reconciling` are transient — they appear only while
 *   work is happening and revert to active/ready when the daemon
 *   finishes. They take precedence over `active`/`ready` so the badge
 *   on /projects accurately mirrors the in-flight state shown in the
 *   timestamp column.
 */
export type ProjectHealth =
  | "failed"
  | "paused"
  | "never-indexed"
  | "empty"
  | "errors"
  | "indexing"
  | "reconciling"
  | "active"
  | "ready"
  | "orphaned";

export interface ProjectsRow {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly marker: string | null;
  readonly markerKind: string | null;
  readonly files: number;
  readonly chunks: number;
  readonly errors: number;
  readonly lastIndexed: string | null;
  readonly lastReconciled: string | null;
  /**
   * Watcher runtime state. `null` when no watcher is registered
   * (orphaned projects, or daemon started with --no-watch).
   */
  readonly watcher: WatcherState | null;
  /** Most recent failure reason if `watcher === "failed"`. */
  readonly watcherFailure: string | null;
  /** Combined health signal — what the user should care about at a glance. */
  readonly health: ProjectHealth;
  /** One-line hint matching `health` (e.g. "click rebuild to populate"). */
  readonly healthHint: string;
  /**
   * In-flight or recently-finished rebuild for this project. Null when
   * no rebuild has been requested recently. Lives in the daemon's
   * in-memory RebuildTracker; lost on daemon restart.
   */
  readonly rebuilding: RebuildProgress | null;
  /**
   * Persisted "rebuild requested" timestamp surviving daemon restarts.
   * Set when the user clicks rebuild, cleared once the post-rebuild
   * reconcile completes. The UI uses this to render "resuming
   * rebuild…" on a row whose rebuild was interrupted by a daemon
   * stop, even though the in-memory tracker is empty.
   */
  readonly rebuildPendingAt: string | null;
  /**
   * Inner project markers absorbed by this project (#286). Each entry is
   * a subdirectory under `root` that carries its own project marker
   * (`.git`, `package.json`, etc.) but is indexed as part of the parent.
   * Empty array when none.
   */
  readonly absorbedMarkers: ReadonlyArray<AbsorbedMarkerRow>;
  /**
   * In-flight reconcile signal for this specific project. When non-null,
   * the daemon is currently reconciling this project — the UI should
   * render "reconciling…" instead of the stale `lastReconciled` stamp.
   * Carries file progress when the indexer has reported it; null fields
   * mean the walk hasn't started reporting yet (pre-stat phase).
   */
  readonly reconciling: {
    readonly indexed: number | null;
    readonly total: number | null;
  } | null;
}

export interface AbsorbedMarkerRow {
  readonly relPath: string;
  readonly marker: string;
  readonly markerKind: string;
}

export interface RebuildProgress {
  readonly status: "running" | "done" | "failed";
  readonly indexed: number;
  /** Null until the file walk completes (the indexer fires onProgress with total once known). */
  readonly totalFiles: number | null;
  readonly startedAt: number; // epoch ms
  readonly completedAt: number | null;
  readonly error: string | null;
}

export interface OrphanRow extends ProjectsRow {
  readonly reason: string;
  readonly rootExists: boolean;
}

/**
 * Discovered under `workspace_roots` but the user hasn't activated it
 * (or has explicitly deactivated it). UI surfaces these with an
 * Activate button; indexer / watcher / reconciler skip them.
 */
export interface InactiveRow {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly marker: string | null;
  readonly markerKind: string | null;
  /** True when a state row already exists with active=0; false for never-recorded projects. */
  readonly known: boolean;
}

export interface ProjectsPayload {
  readonly active: ReadonlyArray<ProjectsRow>;
  readonly inactive: ReadonlyArray<InactiveRow>;
  readonly orphaned: ReadonlyArray<OrphanRow>;
  /**
   * Longest common directory prefix shared by every active row's `root`,
   * with no trailing slash. Empty when there's nothing meaningful in
   * common. The client hides this prefix in row paths and shows it once
   * as a header so wide workspaces stay scannable.
   */
  readonly commonRoot: string;
  /** OS home directory; client renders `~` in its place when present. */
  readonly homeDir: string;
}

export interface SearchRequestBody {
  readonly query: string;
  readonly path?: string;
  readonly limit?: number;
  readonly language?: string;
  readonly coverage?: boolean;
}

export interface SearchHit {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly absPath: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly snippet: string;
  readonly language: string;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<string>;
  readonly matchReasons: ReadonlyArray<string>;
  readonly coverageReason: string | null;
  readonly enrichments: {
    readonly lizard: {
      readonly functionName: string;
      readonly ccn: number;
      readonly nloc: number;
      readonly tokens: number;
      readonly parameters: number;
    } | null;
    readonly findings: ReadonlyArray<{
      readonly analyzer: string;
      readonly ruleId: string;
      readonly severity: "error" | "warning" | "info";
      readonly message: string;
      readonly category: string;
      readonly lineFrom: number;
      readonly lineTo: number;
    }>;
  };
}

export interface SearchPayload {
  readonly resolvedScope: {
    readonly mode: "all" | "project" | "subtree";
    readonly project: { readonly id: string; readonly name: string } | null;
    readonly relPrefix: string | null;
  };
  readonly results: ReadonlyArray<SearchHit>;
  readonly warnings: ReadonlyArray<string>;
}

export type DoctorCheckStatus = "ok" | "warn" | "error";

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
}

export interface McpToolsPayload {
  /** Same shape MCP hosts see via `tools/list`. Surfaces tool name +
   * full description so the web "Add loctx as an MCP server" modal can
   * preview what's installed. inputSchema is intentionally omitted —
   * the modal's audience is humans, not agents. */
  readonly tools: ReadonlyArray<McpToolInfo>;
}

export interface DoctorPayload {
  readonly checks: ReadonlyArray<{
    readonly name: string;
    /** Tri-state from core's runDoctorChecks. The web UI used to
     * collapse this to a boolean and lost the warn vs error
     * distinction — yellow vs red matters when scanning a long
     * checks list. */
    readonly status: DoctorCheckStatus;
    readonly detail: string;
  }>;
  readonly summary: string;
}

export type ConfigSourceKind = "default" | "global" | "env";

export interface ConfigLayerPayload {
  readonly kind: "global";
  /** Absolute path on disk; null when this layer doesn't exist yet. */
  readonly path: string | null;
  /** Per-leaf values literally present in this YAML, keyed by dot-path. */
  readonly values: Record<string, unknown>;
}

export interface ConfigFieldSchemaWire {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly type: "string" | "int" | "bool" | "enum" | "string-array";
  readonly default: unknown;
  readonly enumValues?: ReadonlyArray<string>;
  readonly min?: number;
  readonly max?: number;
}

export interface ConfigSectionSchemaWire {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  readonly fields: ReadonlyArray<ConfigFieldSchemaWire>;
}

export interface ConfigPayload {
  readonly raw: unknown;
  readonly globalSource: string | null;
  /** Per-leaf provenance from `Config.sources`. */
  readonly sources: Readonly<Record<string, ConfigSourceKind>>;
  /** Effective values keyed by dot-path (post-merge). */
  readonly effective: Readonly<Record<string, unknown>>;
  /** What's literally in the global YAML (so the editor can explain inheritance). */
  readonly layers: ReadonlyArray<ConfigLayerPayload>;
  readonly schema: ReadonlyArray<ConfigSectionSchemaWire>;
}

export interface ConfigWriteRequest {
  readonly patch: Record<string, unknown>;
}

export interface ConfigWriteResponse {
  readonly ok: true;
  readonly path: string;
  readonly bytesWritten: number;
  /**
   * True when the daemon hot-reloaded the new config into its live state,
   * so the change is already in effect (analyzers, reconciliation interval,
   * and the /api/config payload). False/absent means it only hit disk and
   * a restart is needed. Settings like daemon port/hostname and the
   * embedding model always need a restart regardless.
   */
  readonly reloaded?: boolean;
}

export interface ConfigWriteError {
  readonly ok: false;
  readonly errors: ReadonlyArray<{ readonly key: string; readonly message: string }>;
}

export interface ModelInfo {
  readonly id: string;
  readonly current: boolean;
  readonly downloaded: boolean;
}

export interface ModelsPayload {
  readonly current: string;
  readonly available: ReadonlyArray<ModelInfo>;
}

export interface FindUsagesRequest {
  readonly symbol: string;
  readonly path?: string;
}

export interface FindUsagesPayload {
  readonly symbol: string;
  readonly defs: ReadonlyArray<UsageHit>;
  readonly refs: ReadonlyArray<UsageHit>;
  /**
   * Surface-level warnings the daemon attaches to the response — mainly
   * the "index is reconciling, hits may be partial" signal (#44) so the
   * UI can warn before the user assumes the symbol is undefined.
   */
  readonly warnings: ReadonlyArray<string>;
}

export interface UsageHit {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
  readonly kind: string;
  /** Chunk body the symbol appeared in. Powers the snippet modal. */
  readonly snippet: string;
}

// ---- find_literal (#357) ----------------------------------------------

export interface FindLiteralPayload {
  readonly pattern: string;
  readonly matches: ReadonlyArray<LiteralHit>;
  /** Distinct files containing at least one match. */
  readonly fileCount: number;
  /**
   * Always populated — reminds callers that the scan covers indexed
   * chunk text. Lines outside any chunk (chunker gaps — see #360)
   * are not searched. For total file coverage, supplement with `rg`.
   */
  readonly coverageNote: string;
  /** Same warnings stream other read endpoints use (reconcile, etc.). */
  readonly warnings: ReadonlyArray<string>;
}

export interface LiteralHit {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkKind: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
  /** Absolute file line (1-indexed). */
  readonly line: number;
  /** 1-indexed column of the first matching byte on that line. */
  readonly column: number;
  /** Full text of the matched line. */
  readonly lineText: string;
}

/**
 * Per-project deep-dive payload behind `GET /api/projects/:id`. The UI
 * uses this for the `/projects/:id` inspect view: header card + stats
 * tables + a scoped search/find-usages panel that reuses the existing
 * /api/search and /api/find-usages endpoints with `path` pre-set.
 */
export interface ProjectDetailPayload {
  readonly project: ProjectsRow;
  readonly stats: ProjectStats;
}

export interface ProjectStats {
  /** File + chunk counts grouped by file extension (".ts", ".py", "<none>"). */
  readonly byExtension: ReadonlyArray<{
    readonly ext: string;
    readonly files: number;
    readonly chunks: number;
  }>;
  /** Files with the most chunks (largest contributors). Capped server-side. */
  readonly topFiles: ReadonlyArray<{
    readonly relPath: string;
    readonly chunks: number;
    readonly indexedAt: string | null;
  }>;
  /** Most-recently-indexed files. Capped server-side. */
  readonly recentFiles: ReadonlyArray<{
    readonly relPath: string;
    readonly indexedAt: string | null;
  }>;
  /** Every file whose `error` column is non-null. Helps drill into indexing failures. */
  readonly failingFiles: ReadonlyArray<{
    readonly relPath: string;
    readonly error: string;
  }>;
}

export interface WatchersPayload {
  readonly enabled: boolean;
  readonly entries: ReadonlyArray<{
    readonly projectId: string;
    readonly projectName: string;
    readonly projectRoot: string;
    readonly state: WatcherState;
    readonly startedAt: string;
    readonly failureReason: string | null;
  }>;
}

// ---- MCP request log (#380-era) ----------------------------------------

export interface McpLogEntry {
  readonly id: number;
  readonly requestedAt: string;
  readonly tool: string;
  /** Full request arguments, JSON-serialized. */
  readonly argumentsJson: string;
  /** Full response payload, JSON-serialized. Null when the call errored. */
  readonly responseJson: string | null;
  /** Error message when the call failed. Null on success. */
  readonly error: string | null;
  readonly ok: boolean;
  readonly elapsedMs: number;
}

export interface McpLogsPayload {
  readonly entries: ReadonlyArray<McpLogEntry>;
  /** Configured rolling row cap (`mcp.log_max_rows`). 0 means logging is off. */
  readonly maxRows: number;
  /** Rows currently retained (≤ maxRows). */
  readonly total: number;
}

export type OpEvent =
  | { readonly type: "log"; readonly message: string }
  | { readonly type: "progress"; readonly current: number; readonly total: number | null }
  | { readonly type: "done"; readonly summary: string }
  | { readonly type: "error"; readonly error: string };

/** Optional analyzer tools the daemon can provision (lizard, semgrep, ast-grep). */
export interface ToolStatus {
  readonly name: string;
  readonly enabled: boolean;
  /** True when the configured `command` resolves to a runnable binary. */
  readonly installed: boolean;
  readonly command: string;
  /** Where loctx would install it (its managed venv / bin path). */
  readonly managedPath: string;
  /**
   * True for a rule-pack tool that has no rules AND no registry fallback —
   * installed but inert. semgrep with a `registryConfig` is NOT needsRules
   * (it runs the community pack); ast-grep with no rules always is.
   */
  readonly needsRules: boolean;
  /**
   * Configured rule directories for rule-pack tools (semgrep, ast-grep),
   * editable inline on the Analyzers panel. `null` for lizard (no rules).
   */
  readonly ruleDirs: ReadonlyArray<string> | null;
  /**
   * Registry fallback ruleset used when `ruleDirs` is empty (semgrep, e.g.
   * `p/default`). `null` for tools without a registry (lizard, ast-grep).
   */
  readonly registryConfig: string | null;
}

export interface ToolsStatusPayload {
  readonly tools: ReadonlyArray<ToolStatus>;
}

/** Result of re-running an installed analyzer over the existing index. */
export type ToolsBackfillResponse =
  | { readonly ok: true; readonly tool: string; readonly backfilled: number }
  | { readonly ok: false; readonly tool: string; readonly error: string };

/** Result of storing a definitions schema (upload / URL / generated). */
export type DefinitionSchemaResponse =
  | { readonly ok: true; readonly path: string; readonly scanned?: number }
  | { readonly ok: false; readonly error: string };

export type ToolsInstallResponse =
  | {
      readonly ok: true;
      readonly tool: string;
      readonly command: string;
      readonly backfilled: number;
      /** Combined stdout+stderr of the install steps (pip / fetch / unzip). */
      readonly log?: string;
    }
  | { readonly ok: false; readonly tool: string; readonly error: string; readonly log?: string };

// ---- agent setup (#agent-setup) ----------------------------------------

/** One file loctx would write for an agent, with the computed action. */
export interface AgentTargetStatus {
  readonly purpose: "mcp" | "rules";
  readonly path: string;
  readonly scope: "project" | "user";
  readonly action: "create" | "update" | "skip";
  readonly reason: string;
}

/** Per-agent setup state for a project: detected, already-registered, and
 *  the files that would change. */
export interface AgentPlanStatus {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly registered: boolean;
  readonly targets: ReadonlyArray<AgentTargetStatus>;
}

export interface AgentSetupPayload {
  readonly projectRoot: string;
  readonly agents: ReadonlyArray<AgentPlanStatus>;
}

export interface AgentSetupApplyResponse {
  readonly ok: true;
  readonly results: ReadonlyArray<{
    readonly path: string;
    readonly action: string;
    readonly ok: boolean;
    readonly error?: string;
  }>;
}

export interface AgentRefreshResponse {
  readonly ok: true;
  /** Number of already-wired projects re-stamped. */
  readonly wired: number;
  /** Total rules/skill files updated across those projects. */
  readonly filesWritten: number;
  readonly projects: ReadonlyArray<{ readonly root: string; readonly updated: number }>;
}
