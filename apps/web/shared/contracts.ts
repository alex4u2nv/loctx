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
    readonly configProject: string | null;
    readonly dataDir: string;
    readonly vectorDir: string;
    readonly stateDb: string;
    readonly embeddingProvider: string;
    readonly embeddingModel: string;
    readonly retrievalMode: string;
    readonly watcherDebounceMs: number;
    readonly reconciliationIntervalSeconds: number;
    readonly reconciliationRunOnStart: boolean;
  };
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly root: string;
  }>;
}

export type WatcherState = "active" | "paused" | "failed";

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
   * Watcher state for this project. `null` when no watcher is registered
   * (orphaned projects, or daemon started with --no-watch).
   */
  readonly watcher: WatcherState | null;
  /** Most recent failure reason if `watcher === "failed"`. */
  readonly watcherFailure: string | null;
}

export interface OrphanRow extends ProjectsRow {
  readonly reason: string;
  readonly rootExists: boolean;
}

export interface ProjectsPayload {
  readonly active: ReadonlyArray<ProjectsRow>;
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

export interface ConfigPayload {
  readonly raw: unknown;
  readonly globalSource: string | null;
  readonly projectSource: string | null;
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
