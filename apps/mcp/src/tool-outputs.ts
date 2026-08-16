/**
 * Tool input/output wire types (#542 split from registry.ts). Pure
 * types; the handlers in registry.ts produce them.
 */

import type {
  DuplicateGroup,
  ProjectId,
  QualityReport,
  Runtime,
  SearchResponse,
  SemanticDuplicatesResult,
  SymbolRefHit,
  UsageSummary,
} from "@loctx/core";
import type { ProcessFaultSnapshot } from "./process-faults.js";

// ---- input / output types ----------------------------------------------

export interface SearchInput {
  readonly query: string;
  readonly path?: string;
  readonly limit?: number;
  readonly language?: string;
}

export interface StatusInput {
  readonly include_indexed_counts?: boolean;
}

export interface RefreshInput {
  readonly path?: string;
}

export interface ProjectStatusEntry {
  readonly id: ProjectId;
  readonly name: string;
  readonly root: string;
  /**
   * "active": being watched and re-indexed.
   * "orphaned": data still in SQLite + LanceDB and search hits return; no
   * longer maintained because workspace_roots changed or the root moved.
   */
  readonly status: "active" | "inactive" | "orphaned";
  /** Only set on orphaned entries. */
  readonly orphanReason?: "outside-roots" | "missing";
  readonly lastIndexedAt: string | null;
  /** Last reconciliation pass for this project (#14). Null if never reconciled. */
  readonly lastReconciledAt: string | null;
  /** Marker file/dir that identified the directory as a project (#81). Active only. */
  readonly marker?: string;
  /** Marker confidence group (#81). Active only. */
  readonly markerKind?: "git" | "ide" | "build";
}

/**
 * Liveness signal for the index state at the moment a tool call ran.
 * Surfaced on every tool response so agents can disambiguate "symbol
 * doesn't exist" from "symbol not yet (re-)indexed because the
 * daemon is mid-pass." See #43.
 *
 * `reconciling=true` means search / find_usages results may be
 * partial — particularly for the project named in `currentProject`.
 * Idle calls return `reconciling=false` and the other fields stay
 * informational (e.g. `total=0`).
 *
 * `reconciling="unknown"` (#453): this server can't observe reconcile
 * state. The stdio MCP binary never loops a reconciler — a separate
 * `loctx start` daemon owns that — so when a daemon holds the lock, its
 * in-memory progress is invisible here. Reporting `false` would be a
 * lie ("index is settled") when the daemon might be mid-pass, so we say
 * `unknown` instead. Agents should treat it like `true` for 0-hit
 * semantics: the index may be updating; verify or retry.
 */
export interface IndexHealth {
  readonly reconciling: boolean | "unknown";
  readonly startedAt: string | null;
  readonly currentProject: string | null;
  readonly completed: number;
  readonly total: number;
  /** Files indexed so far inside `currentProject`. Null when idle. */
  readonly currentProjectIndexed: number | null;
  readonly currentProjectTotal: number | null;
}

export interface StatusOutput {
  readonly configPath: string | null;
  readonly paths: Runtime["config"]["paths"];
  readonly embedding: Runtime["config"]["embedding"];
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<ProjectStatusEntry>;
  readonly indexedFileCounts?: Readonly<Record<string, number>>;
  readonly indexHealth: IndexHealth;
  /**
   * Swallowed process faults on the long-lived stdio server (#452).
   * Present only when this server injected a fault tracker; a nonzero
   * `total` means the server stayed up through N unhandled
   * rejections/exceptions that would otherwise be invisible.
   */
  readonly processFaults?: ProcessFaultSnapshot;
  /**
   * What loctx is NOT indexing — directly observable so agents know
   * when to fall back to `grep`/`find` without guessing. Sourced from
   * the resolved filtering rules. #371: an agent doing an audit
   * should be able to see `.git/`, `node_modules/`, lockfiles in here
   * and conclude "if my target is in one of these, I need grep."
   */
  readonly exclusions: ExclusionRules;
  /**
   * Estimated "value served" so far (#value-metrics): tokens the agent
   * saved by getting ranked snippets from loctx instead of grep +
   * read-whole-file, plus file reads avoided. An estimate — figures are
   * approximate. Lets an agent see its own retrieval efficiency.
   */
  readonly value: UsageSummary;
}

export interface ExclusionRules {
  /** Directory names skipped wherever they appear (e.g. `.git`, `node_modules`). */
  readonly ignoredDirs: ReadonlyArray<string>;
  /** Basename glob patterns marked as noise (lockfiles, build outputs). */
  readonly noiseGlobs: ReadonlyArray<string>;
  /** Basename glob patterns marked as potentially secret (env files, key materials). */
  readonly secretGlobs: ReadonlyArray<string>;
  /** Whitelisted basenames that override `noiseGlobs` (e.g. `Pipfile.lock`). */
  readonly allowedNamedFiles: ReadonlyArray<string>;
}

export interface RefreshOutput {
  readonly summaries: ReadonlyArray<{
    readonly projectId: string;
    readonly indexed: number;
    readonly skipped: number;
    readonly failed: number;
    readonly elapsedSeconds: number;
  }>;
}

export interface FindUsagesInput {
  readonly symbol: string;
  /**
   * Optional path to scope the lookup to a single project. If absent, the
   * tool searches every project that contains a row for `symbol`.
   * Anything outside `workspace_roots` is rejected.
   */
  readonly path?: string;
}

export interface FindUsagesOutput {
  readonly symbol: string;
  /** Per-project hits. Empty list when the symbol is unknown. */
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly projectName: string;
    readonly defs: ReadonlyArray<SymbolRefHit>;
    readonly refs: ReadonlyArray<SymbolRefHit>;
  }>;
  /**
   * Scope-resolution notes, e.g. when a `path` inside an unindexed inner
   * project was scoped to its indexed parent (#276). Empty in the common
   * case. Surfaced so a broadened scope is never silent.
   */
  readonly warnings: ReadonlyArray<string>;
  readonly indexHealth: IndexHealth;
}

export interface FindDuplicatesInput {
  /** Minimum file count for a group to surface. Default 2. */
  readonly minMembers?: number;
  /** Absolute path to scope to one project; omit to span the workspace. */
  readonly path?: string;
}

export interface FindDuplicatesOutput {
  readonly groups: ReadonlyArray<DuplicateGroup>;
  readonly indexHealth: IndexHealth;
  /** Scope-resolution notes (e.g. path narrowed to an indexed parent). */
  readonly warnings?: ReadonlyArray<string>;
  /**
   * Non-null when the duplicate-detection analyzer is disabled in
   * config — surfaces *why* `groups` is empty so an agent can tell
   * "feature off" from "feature on, nothing found." Names the
   * exact config knob the user would flip to enable it.
   */
  readonly disabled: string | null;
  /**
   * Embedding-based near-duplicate groups (#523), null when the
   * semantic pass didn't run — `semanticDisabled` says why. Distinct
   * from `groups` (exact token-window matches): these are "same
   * meaning, different text" hits over the stored vectors.
   */
  readonly semantic: SemanticDuplicatesResult | null;
  /** Same convention as `disabled`, for the semantic pass alone. */
  readonly semanticDisabled: string | null;
}

export interface QualityReportOutput {
  readonly projectId: string;
  readonly projectName: string;
  readonly report: QualityReport;
  /**
   * Non-null when the stored per-file quality rules are disabled in
   * config. The query-time cross-file rules run regardless, so a
   * non-null value means the report is PARTIAL, not empty.
   */
  readonly disabled: string | null;
  readonly indexHealth: IndexHealth;
  readonly warnings?: ReadonlyArray<string>;
}

export interface SearchOutput extends SearchResponse {
  readonly indexHealth: IndexHealth;
}

// ---- find_literal (#357) -----------------------------------------------

export interface FindLiteralInput {
  /** Substring to match. Plain text — SQL LIKE wildcards are pre-escaped. */
  readonly pattern: string;
  /** Optional absolute path to scope the audit. */
  readonly path?: string;
}

export interface LiteralMatchHit {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkKind: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
  /** Absolute file line (1-indexed) of the match. */
  readonly line: number;
  /** 1-indexed column of the first matching byte on that line. */
  readonly column: number;
  /** Full text of the matched line. */
  readonly lineText: string;
}

export interface FindLiteralOutput {
  readonly pattern: string;
  readonly matches: ReadonlyArray<LiteralMatchHit>;
  /** Distinct files containing at least one match. Computed from `matches`. */
  readonly fileCount: number;
  /**
   * Scope-resolution notes, e.g. when a `path` inside an unindexed inner
   * project was scoped to its indexed parent (#276). Empty in the common
   * case. Surfaced so a narrowed/broadened scope is never silent.
   */
  readonly warnings: ReadonlyArray<string>;
  readonly indexHealth: IndexHealth;
  /**
   * Always present — set by the server to remind callers that the
   * scan covers indexed chunk text. Lines outside any chunk (per
   * #360) are not searched. For total file coverage, supplement
   * with `rg`.
   */
  readonly coverageNote: string;
}

export interface RefreshOutputWithHealth extends RefreshOutput {
  readonly indexHealth: IndexHealth;
}

// ---- admin_workspace (privileged, gated by mcp.admin_enabled) ----------

export type AdminAction = "get_config" | "set_config" | "compact" | "backfill_analyzers";

export interface AdminInput {
  readonly action: AdminAction;
  /** set_config: dot-path key → value patch, validated against the config schema. */
  readonly patch?: Record<string, unknown>;
  /** backfill_analyzers: optional analyzer names to scope to (default: all enabled). */
  readonly targets?: ReadonlyArray<string>;
}

/** One config field's effective (merged) value, for `get_config`. */
export interface AdminConfigSetting {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly value: unknown;
  readonly default: unknown;
}

export type AdminOutput =
  | {
      readonly action: "get_config";
      readonly configPath: string | null;
      readonly settings: ReadonlyArray<AdminConfigSetting>;
    }
  | {
      readonly action: "set_config";
      readonly ok: true;
      readonly path: string;
      readonly bytesWritten: number;
      /** True when the daemon hot-reloaded the change; false ⇒ restart to apply. */
      readonly reloaded: boolean;
      readonly applied: Record<string, unknown>;
    }
  | {
      readonly action: "compact";
      readonly beforeBytes: number;
      readonly afterBytes: number;
      readonly freedBytes: number;
    }
  | {
      readonly action: "backfill_analyzers";
      readonly enqueued: number;
    };

/** Side-effect hooks the host wires into privileged admin handlers. */
export interface AdminOptions {
  /**
   * Re-read the YAML into the daemon's live config after `set_config`. Present
   * only for the in-daemon HTTP transport (where a reload affects the serving
   * process); absent for the stdio binary, where the write lands on disk and
   * applies on the next daemon restart.
   */
  readonly reloadConfig?: () => void | Promise<void>;
  /**
   * Snapshot of swallowed process faults (#452). Injected by the stdio
   * server (which owns the unhandledRejection/uncaughtException
   * handlers) so `workspace_status` can surface them. Absent for the web
   * HTTP transport, which runs in the daemon process with its own
   * fault handling.
   */
  readonly processFaults?: () => ProcessFaultSnapshot;
}
