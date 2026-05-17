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
 *   - `active`        watching + has data
 *   - `ready`         indexed, no watcher (daemon started with --no-watch)
 *   - `orphaned`      project no longer under workspace_roots
 */
export type ProjectHealth =
  | "failed"
  | "paused"
  | "never-indexed"
  | "empty"
  | "errors"
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

export interface DoctorPayload {
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly ok: boolean;
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
}

export interface UsageHit {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
  readonly kind: string;
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

export type OpEvent =
  | { readonly type: "log"; readonly message: string }
  | { readonly type: "progress"; readonly current: number; readonly total: number | null }
  | { readonly type: "done"; readonly summary: string }
  | { readonly type: "error"; readonly error: string };
