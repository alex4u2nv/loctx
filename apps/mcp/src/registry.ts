/**
 * Transport-agnostic registry for the loctx MCP tools.
 *
 * The same registry is consumed by:
 *   - apps/mcp/src/server.ts             (stdio transport binary)
 *   - apps/web/app/mcp/route.ts          (Next.js SSE route)
 *
 * Public exports:
 *   - {@link tools}              — pure async handlers `(runtime, input) => output`.
 *                                  Useful for tests and direct API routes.
 *   - {@link TOOL_DEFINITIONS}   — JSON-schema tool catalog returned by `tools/list`.
 *   - {@link registerTools}      — wires `tools/list` + `tools/call` onto an MCP Server.
 */

import { join } from "node:path";
import {
  assertNotReconciling,
  type DuplicateGroup,
  effectiveSettings,
  estimateQueryValue,
  FIND_LITERAL_COVERAGE_NOTE,
  findSymbolUsages,
  inventoryProjects,
  isValueTool,
  type ProjectId,
  parseFindLiteralToolInput,
  parseFindUsagesToolInput,
  parseSearchToolInput,
  type QualityReport,
  ReconcileInFlightError,
  type Runtime,
  readActiveDaemon,
  resolveProjectScope,
  resolveUnderWorkspaceRoots,
  runQualityReport,
  runSemanticDuplicates,
  type SearchResponse,
  type SemanticDuplicatesResult,
  type SymbolRefHit,
  summarizeUsage,
  toUsageDeltas,
  type UsageSummary,
  Validator,
  writeConfigPatch,
} from "@loctx/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

export class ToolError extends Error {}

/**
 * Enforce the documented input contract for `path` arguments: anything
 * outside the configured `workspace_roots` is rejected, mirroring the
 * HTTP layer's 403. Returns the canonicalized path (or undefined when
 * no path was given) so handlers scope against the resolved form.
 */
function confinedPath(runtime: Runtime, path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  const confined = resolveUnderWorkspaceRoots(path, runtime.config.workspaceRoots);
  if (confined === null) {
    throw new ToolError(`path ${path} is not under any configured workspace_root`);
  }
  return confined;
}

/** Core's write-safety gate (#207), surfaced as a tool error. */
function guardReconcile(runtime: Runtime, opName: string): void {
  try {
    assertNotReconciling(runtime.reconciler, opName);
  } catch (err) {
    if (err instanceof ReconcileInFlightError) throw new ToolError(err.message);
    throw err;
  }
}

/**
 * Resolve the tri-state `reconciling` value (#453). Pure so it can be
 * unit-tested without touching the lock file.
 *
 *   - this process's reconciler is running        → true
 *   - idle, and no *other* daemon owns the lock    → false (authoritative)
 *   - idle, but another live daemon holds the lock → "unknown"
 *     (that daemon runs the reconciler loop; we can't see its progress)
 */
export function reconcilingState(
  running: boolean,
  activeDaemon: { readonly pid: number } | null,
  selfPid: number,
): boolean | "unknown" {
  if (running) return true;
  if (activeDaemon !== null && activeDaemon.pid !== selfPid) return "unknown";
  return false;
}

function currentIndexHealth(runtime: Runtime): IndexHealth {
  const s = runtime.reconciler.status();
  const activeDaemon = readActiveDaemon(runtime.config.paths.dataDir);
  return Object.freeze({
    reconciling: reconcilingState(s.running, activeDaemon, process.pid),
    startedAt: s.startedAt,
    currentProject: s.currentProjectName,
    completed: s.completed,
    total: s.total,
    currentProjectIndexed: s.currentProjectIndexed,
    currentProjectTotal: s.currentProjectTotal,
  });
}

// ---- pure handlers -----------------------------------------------------

export const tools = {
  async search(runtime: Runtime, input: unknown): Promise<SearchOutput> {
    const v = new Validator(ToolError, "search_workspace");
    const data = v.requireRecord(input ?? {}, "arguments");

    // Shared per-operation input spec (SRV-5) — identical bounds +
    // error strings to POST /api/search. An out-of-range `limit` is
    // now REJECTED (matching HTTP's 400) instead of silently clamped:
    // a clamp hides caller bugs behind a plausible-looking result.
    const parsed = parseSearchToolInput(data, ToolError);
    const path = confinedPath(runtime, parsed.path);
    const response = await runtime.searcher.search({
      query: parsed.query,
      ...(path !== undefined ? { path } : {}),
      limit: parsed.limit,
      ...(parsed.language !== undefined ? { language: parsed.language } : {}),
      ...(parsed.coverage ? { coverage: true } : {}),
    });
    return Object.freeze({ ...response, indexHealth: currentIndexHealth(runtime) });
  },

  async status(runtime: Runtime, input: unknown): Promise<StatusOutput> {
    const v = new Validator(ToolError, "workspace_status");
    const data = v.requireRecord(input ?? {}, "arguments");
    const includeCounts = v.getBool(data, "include_indexed_counts") ?? false;

    const inventory = inventoryProjects(runtime.discovery, runtime.state);
    const entries: ProjectStatusEntry[] = [
      ...inventory.active.map(
        (a): ProjectStatusEntry => ({
          id: a.project.id,
          name: a.project.name,
          root: a.project.root,
          status: "active",
          lastIndexedAt: a.lastIndexedAt,
          lastReconciledAt: a.lastReconciledAt,
          marker: a.marker,
          markerKind: a.markerKind,
        }),
      ),
      ...inventory.inactive.map(
        (i): ProjectStatusEntry => ({
          id: i.project.id,
          name: i.project.name,
          root: i.project.root,
          status: "inactive",
          lastIndexedAt: null,
          lastReconciledAt: null,
          marker: i.marker,
          markerKind: i.markerKind,
        }),
      ),
      ...inventory.orphaned.map(
        (o): ProjectStatusEntry => ({
          id: o.project.id,
          name: o.project.name,
          root: o.project.root,
          status: "orphaned",
          orphanReason: o.reason,
          lastIndexedAt: o.lastIndexedAt,
          lastReconciledAt: o.lastReconciledAt,
        }),
      ),
    ];
    const indexHealth = currentIndexHealth(runtime);
    const baseline: StatusOutput = {
      configPath: runtime.config.source ?? null,
      paths: runtime.config.paths,
      embedding: runtime.config.embedding,
      workspaceRoots: runtime.config.workspaceRoots,
      projects: entries,
      indexHealth,
      value: summarizeUsage(runtime.state.readUsageStats()).workspace,
      exclusions: Object.freeze({
        // Sets aren't JSON-serializable on the wire; emit as a sorted
        // array so the response stays stable across runs.
        ignoredDirs: Object.freeze([...runtime.rules.ignoredDirs].sort()),
        noiseGlobs: Object.freeze([...runtime.rules.noiseGlobs]),
        secretGlobs: Object.freeze([...runtime.rules.secretGlobs]),
        allowedNamedFiles: Object.freeze([...runtime.rules.allowedNamedFiles].sort()),
      }),
    };
    if (!includeCounts) return baseline;

    return {
      ...baseline,
      indexedFileCounts: Object.freeze(
        Object.fromEntries(
          entries.map((p) => [p.id, runtime.state.listFiles(p.id).length] as const),
        ),
      ),
    };
  },

  async findUsages(runtime: Runtime, input: unknown): Promise<FindUsagesOutput> {
    const v = new Validator(ToolError, "find_usages");
    const data = v.requireRecord(input ?? {}, "arguments");
    // Shared per-operation input spec (SRV-5) — identical bounds +
    // error strings to POST /api/find-usages.
    const parsed = parseFindUsagesToolInput(data, ToolError);
    const symbol = parsed.symbol;
    const path = confinedPath(runtime, parsed.path);

    // Shared resolve-scope → findSymbol sweep (#449). findSymbolUsages
    // prefers the deepest *indexed* ancestor over an unindexed inner
    // marker (e.g. a monorepo `packages/core`), so a path inside a
    // nested package still finds usages in the indexed parent instead
    // of returning an empty list (#276) — identically across the MCP
    // tool, the REST endpoint, and the CLI fallback.
    const result = findSymbolUsages(runtime.discovery, runtime.state, symbol, path);
    if (result.kind === "outside-indexed") {
      throw new ToolError(
        `path ${path} is not inside any indexed project; omit path to search every project.`,
      );
    }
    return Object.freeze({
      symbol,
      projects: Object.freeze(
        result.projects.map((p) => ({
          projectId: p.project.id as string,
          projectName: p.project.name,
          defs: p.defs,
          refs: p.refs,
        })),
      ),
      warnings: result.warnings,
      indexHealth: currentIndexHealth(runtime),
    });
  },

  async findDuplicates(runtime: Runtime, input: unknown): Promise<FindDuplicatesOutput> {
    const v = new Validator(ToolError, "find_duplicates");
    const data = v.requireRecord(input ?? {}, "arguments");
    const minMembers = v.getInt(data, "min_members", { nonNegative: true }) ?? 2;
    // Empty groups have two unrelated causes: feature disabled, or
    // feature enabled with no duplicates. Tell the caller which —
    // an agent reading "groups: []" today can't distinguish them
    // and might wrongly conclude no duplicates exist when the
    // analyzer simply hasn't been turned on.
    const an = runtime.config.analyzers;
    let disabled: string | null = null;
    if (!an.backgroundEnabled) {
      disabled =
        "analyzers.background_enabled is false in config — enable it and restart the daemon.";
    } else if (!an.duplicates.enabled) {
      disabled =
        "analyzers.duplicates.enabled is false in config — enable it and restart the daemon.";
    }

    // Optional project scope. Unscoped find_duplicates over a workspace
    // with a large project is expensive (the analyzer emits a 50-token
    // window per line); pass `path` to narrow to one project.
    const path = confinedPath(runtime, v.getStr(data, "path"));
    const warnings: string[] = [];
    let projectId: string | null = null;
    if (path !== undefined) {
      const scope = resolveProjectScope(runtime.discovery, runtime.state, path, warnings);
      if (scope.project === null) {
        throw new ToolError(
          `path ${path} is not inside any indexed project; omit path to scan every project.`,
        );
      }
      projectId = scope.project.id;
    }

    const groups = runtime.state.findDuplicateGroups(Math.max(2, minMembers), projectId);

    // Semantic near-duplicates (#523): shared query-time pass — the
    // web duplicates inspector runs the identical code, so gating,
    // caps, and truncation semantics cannot drift between surfaces.
    const {
      semantic,
      semanticDisabled,
      warning: semanticWarning,
    } = await runSemanticDuplicates(runtime, (projectId as ProjectId | null) ?? null, minMembers);
    if (semanticWarning !== null) warnings.push(semanticWarning);

    return Object.freeze({
      groups: Object.freeze(groups),
      indexHealth: currentIndexHealth(runtime),
      disabled,
      semantic,
      semanticDisabled,
      ...(warnings.length > 0 ? { warnings: Object.freeze(warnings) } : {}),
    });
  },

  async qualityReport(runtime: Runtime, input: unknown): Promise<QualityReportOutput> {
    const v = new Validator(ToolError, "quality_report");
    const data = v.requireRecord(input ?? {}, "arguments");
    const limitRaw = v.getInt(data, "limit", { nonNegative: true }) ?? 20;
    const limit = Math.min(Math.max(1, limitRaw), 100);
    const rule = v.getStr(data, "rule");
    const path = confinedPath(runtime, v.getStr(data, "path"));

    // The report is per-project (its vector scans and ref counts are
    // project-scoped). Resolve from `path`, or default when exactly one
    // project is indexed.
    const warnings: string[] = [];
    let project: { id: ProjectId; name: string; root: string };
    if (path !== undefined) {
      const scope = resolveProjectScope(runtime.discovery, runtime.state, path, warnings);
      if (scope.project === null) {
        throw new ToolError(`path ${path} is not inside any indexed project.`);
      }
      project = scope.project;
    } else {
      const active = runtime.state.listProjects().filter((p) => p.active);
      const sole = active.length === 1 ? active[0] : undefined;
      if (sole === undefined) {
        throw new ToolError(
          `quality_report is per-project — pass 'path' to pick one (indexed: ${active
            .map((p) => p.name)
            .join(", ")}).`,
        );
      }
      project = sole;
    }

    const an = runtime.config.analyzers;
    let disabled: string | null = null;
    if (!an.backgroundEnabled || !an.quality.enabled) {
      disabled =
        "analyzers.quality.enabled (with analyzers.background_enabled) is off — stored per-file rules are missing from this report; the query-time cross-file rules below still ran. Enable and backfill for the full picture.";
    }

    const report = await runQualityReport(
      runtime,
      { id: project.id, name: project.name, root: project.root },
      { limit, ...(rule !== undefined ? { rule } : {}) },
    );
    return Object.freeze({
      projectId: project.id as string,
      projectName: project.name,
      report,
      disabled,
      indexHealth: currentIndexHealth(runtime),
      ...(warnings.length > 0 ? { warnings: Object.freeze(warnings) } : {}),
    });
  },

  async findLiteral(runtime: Runtime, input: unknown): Promise<FindLiteralOutput> {
    const v = new Validator(ToolError, "find_literal");
    const data = v.requireRecord(input ?? {}, "arguments");
    // Shared per-operation input spec (SRV-5) — identical bounds +
    // error strings to POST /api/find-literal.
    const parsed = parseFindLiteralToolInput(data, ToolError);
    const pattern = parsed.pattern;
    const path = confinedPath(runtime, parsed.path);

    // resolveProjectScope prefers the deepest *indexed* ancestor over an
    // unindexed inner marker and derives the subtree prefix, so a path
    // inside a nested package (e.g. `packages/core`) scopes to the indexed
    // parent with a `packages/core/` prefix instead of an empty inner
    // project that returns zero matches (#276).
    const warnings: string[] = [];
    let projectId: ProjectId | undefined;
    let relPathPrefix: string | undefined;
    if (path !== undefined && path !== "") {
      const scope = resolveProjectScope(runtime.discovery, runtime.state, path, warnings);
      if (scope.project === null) {
        throw new ToolError(
          `path ${path} is not inside any indexed project; omit path to search every project.`,
        );
      }
      projectId = scope.project.id;
      if (scope.relPrefix !== null) relPathPrefix = scope.relPrefix;
    }

    const opts: { projectId?: ProjectId; relPathPrefix?: string } = {};
    if (projectId !== undefined) opts.projectId = projectId;
    if (relPathPrefix !== undefined) opts.relPathPrefix = relPathPrefix;
    const raw = runtime.state.findLiteralMatches(pattern, opts);
    const matches: LiteralMatchHit[] = raw.map((m) => ({
      projectId: m.projectId,
      projectName: m.projectName,
      relPath: m.relPath,
      chunkKind: m.chunkKind,
      chunkStartLine: m.chunkStartLine,
      chunkEndLine: m.chunkEndLine,
      line: m.line,
      column: m.column,
      lineText: m.lineText,
    }));
    const fileCount = new Set(matches.map((m) => `${m.projectId}:${m.relPath}`)).size;
    return Object.freeze({
      pattern,
      matches: Object.freeze(matches),
      fileCount,
      warnings: Object.freeze(warnings),
      indexHealth: currentIndexHealth(runtime),
      // Shared with the HTTP transport so the wording can't drift (SRV-9).
      coverageNote: FIND_LITERAL_COVERAGE_NOTE,
    });
  },

  async refresh(runtime: Runtime, input: unknown): Promise<RefreshOutputWithHealth> {
    const v = new Validator(ToolError, "refresh_workspace");
    const data = v.requireRecord(input ?? {}, "arguments");
    const path = confinedPath(runtime, v.getStr(data, "path"));

    // Mirror POST /api/index: a concurrent indexer pass against a
    // project the reconciler is also walking races on the same LanceDB
    // table (#207).
    guardReconcile(runtime, "refresh");

    // A refresh exists to pick up new/changed projects — never serve it
    // from the discovery cache (#443).
    runtime.discovery.invalidate();
    const projects = path
      ? [runtime.discovery.resolveProject(path)].filter((p) => p !== null)
      : runtime.discovery.discoverProjects();

    const summaries: RefreshOutput["summaries"][number][] = [];
    for (const project of projects) {
      const summary = await runtime.indexer.indexProject(project);
      summaries.push({
        projectId: summary.project.id,
        indexed: summary.indexed,
        skipped: summary.skipped,
        failed: summary.failed,
        elapsedSeconds: summary.elapsedSeconds,
      });
    }
    return Object.freeze({
      summaries: Object.freeze(summaries),
      indexHealth: currentIndexHealth(runtime),
    });
  },

  async admin(runtime: Runtime, input: unknown, options: AdminOptions = {}): Promise<AdminOutput> {
    const v = new Validator(ToolError, "admin_workspace");
    const data = v.requireRecord(input ?? {}, "arguments");
    const action = v.getStr(data, "action") as AdminAction | undefined;
    if (action === undefined) {
      throw new ToolError(
        "action is required (one of: get_config, set_config, compact, backfill_analyzers)",
      );
    }

    switch (action) {
      case "get_config": {
        // Effective (merged) value of every schema field, plucked off the
        // live config tree — same core walk the admin Config editor uses
        // (SRV-8), so the two surfaces can't diverge.
        const settings: ReadonlyArray<AdminConfigSetting> = effectiveSettings(runtime.config);
        return Object.freeze({
          action,
          configPath: runtime.config.source ?? null,
          settings: Object.freeze(settings),
        });
      }

      case "set_config": {
        const patch = data["patch"];
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
          throw new ToolError(
            'set_config requires a `patch` object of dot-path keys → values (e.g. {"maintenance.compactIntervalHours": 12}). Call action=get_config to see valid keys.',
          );
        }
        if (Object.keys(patch).length === 0) {
          throw new ToolError("patch is empty — nothing to write");
        }
        // `source` is null only when the global YAML doesn't exist yet;
        // writeConfigPatch creates it at the canonical config-dir path.
        const path = runtime.config.source ?? join(runtime.config.paths.configDir, "config.yaml");
        const result = writeConfigPatch(path, patch as Record<string, unknown>);
        if (!result.ok) {
          throw new ToolError(
            `invalid config patch: ${result.errors.map((e) => `${e.key}: ${e.message}`).join("; ")}`,
          );
        }
        // Hot-reload when the host wired it (in-daemon HTTP transport). The
        // stdio binary has no reload hook — the write still lands on disk and
        // applies on the next restart, reported via reloaded=false.
        let reloaded = false;
        if (options.reloadConfig !== undefined) {
          try {
            await options.reloadConfig();
            reloaded = true;
          } catch {
            // Reload failure mustn't fail the write — the YAML is on disk.
            reloaded = false;
          }
        }
        return Object.freeze({
          action,
          ok: true as const,
          path: result.path,
          bytesWritten: result.bytesWritten,
          reloaded,
          applied: patch as Record<string, unknown>,
        });
      }

      case "compact": {
        // Mirror /api/compact: refuse during a reconcile so we don't fight
        // the indexer for the LanceDB writer lock.
        guardReconcile(runtime, "compact");
        const { beforeBytes, afterBytes } = await runtime.compactVectors();
        return Object.freeze({
          action,
          beforeBytes,
          afterBytes,
          freedBytes: Math.max(0, beforeBytes - afterBytes),
        });
      }

      case "backfill_analyzers": {
        const rawTargets = data["targets"];
        let targets: ReadonlyArray<string> | undefined;
        if (rawTargets !== undefined) {
          if (!Array.isArray(rawTargets) || rawTargets.some((t) => typeof t !== "string")) {
            throw new ToolError("targets must be an array of analyzer names (strings)");
          }
          targets = rawTargets as ReadonlyArray<string>;
        }
        const { enqueued } = await runtime.backfillAnalyzers(targets);
        return Object.freeze({ action, enqueued });
      }

      default: {
        // Exhaustiveness guard — a new AdminAction must add a case above.
        const _never: never = action;
        throw new ToolError(`unknown admin action: ${String(_never)}`);
      }
    }
  },
} as const;

// ---- tool catalog ------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    name: "search_workspace",
    description:
      "**Use when the question is conceptual rather than literal**, across any indexed content — code, prose docs, runbooks, agent specs, skill/prompt files, business-process notes. E.g. 'where do we debounce websocket reconnects', 'how is tenant id propagated', 'which skill handles refund escalation', 'how is the vendor-onboarding process documented', 'where is the contract review workflow described'. **Beats `grep`** when no single token captures the question: the vector branch surfaces chunks that contain *no token-level match* — a runbook that *describes* a process without using the user's exact phrasing, a function whose body implements an idea without naming it. Each hit includes the **surrounding chunk** (function body, doc section, list/heading region), so the snippet is usually enough to act without a follow-up `Read`. Pass `coverage: true` for refactor planning ('what else touches X'): top hits are expanded via the symbol cross-ref graph (each expansion carries a `coverageReason`). **Not** the right tool for exhaustive literal-string audits — the lexical branch returns ranked partial-match chunks, not a grep-style file list. For that, use `find_literal`. For exact-symbol cross-references, use `find_usages`. Each result carries `absPath`, `relPath`, `projectName`, line range, score, snippet, `matchReasons`, `analyzer` (AST metadata), `sources` (vector|lexical), and `referencedBy` — the inbound-link count from the doc cross-link graph (#427). Ranking now boosts authoritative source-of-truth docs (high `referencedBy`, `matchReasons: authoritative`) and concept-defining headings (`definition`) while down-weighting derivative slides/catalog files (`derivative`); re-rank on `referencedBy` if you want the canonical doc first. Pass `path` to scope to a project or subtree. Highest-leverage on unfamiliar or large workspaces (code OR docs); on a small set you've already explored, `grep` + `Read` may be faster. `indexHealth.reconciling` signals partial results when a re-index is in flight.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural-language or code-fragment query." },
        path: {
          type: "string",
          description:
            "Absolute file or directory path to scope the search. If `path` is a project root, the search is limited to that project. If `path` is inside a project, results are further restricted to that subtree. Omit to search every indexed project.",
        },
        limit: { type: "integer", minimum: 1, default: 10 },
        language: {
          type: "string",
          description: "Filter results to a single language (python, typescript, go, ...).",
        },
        coverage: {
          type: "boolean",
          default: false,
          description:
            "Concept/refactor coverage mode. After the normal ranked list, expand each top hit by following symbol cross-references (callers, importers) and append them with a `coverageReason` explaining why each was included. Use for 'what else touches X' questions before a refactor.",
        },
      },
    },
  },
  {
    name: "workspace_status",
    description:
      "**Pre-flight check before using any other loctx tool. Call once when entering an unfamiliar repo to confirm loctx covers it.** Cheap (in-memory metadata, no scan). If the current repo isn't listed in `projects`, every other loctx tool will return empty for it and you should fall back to `grep`/`find`. If it *is* listed, prefer `find_usages` for symbols, `find_literal` for literal audits, and `search_workspace` for conceptual queries over `grep`. Also returns `indexHealth.reconciling` — when true, a re-index is in flight and other tools may return partial results until it completes. Use `include_indexed_counts: true` to add per-project file counts for a coverage check.",
    inputSchema: {
      type: "object",
      properties: {
        include_indexed_counts: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "find_usages",
    description:
      "**Use when you ask 'where is X used' or 'where is X defined' and X is a symbol name** (function, class, exported identifier). **Beats `grep -rn X`** because each hit is *classified* as `def`|`call`|`import`|`reference` instead of just a text match, and includes the **surrounding chunk** (function body, class body) so you don't need a follow-up `Read` of the file. One call replaces find + grep + several Read calls. **Not** the right tool for file paths or arbitrary literal strings — use `find_literal` for those, or `grep` for safety-critical audits. Each hit carries `relPath`, `line` (exact reference), `chunkStartLine`/`chunkEndLine`, `kind`, and the chunk body. Pass `path` to scope to one project; omit to search every project that knows the symbol. **0-hit semantics:** check `indexHealth.reconciling`. If `true` or `unknown`, the file may not be re-indexed yet (an `unknown` value means a separate daemon owns reconciliation and this server can't see its progress) — retry after the pass, or verify with `workspace_status`. If `false`, either the symbol genuinely isn't defined or this repo isn't indexed (verify with `workspace_status`); don't silently fall back to `grep` on the first 0-hit or you'll lose the signal that the index is the problem. Highest-leverage on unfamiliar or large codebases; for a small repo you've already explored, `grep` may be faster end-to-end.",
    inputSchema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: {
          type: "string",
          description: "Identifier name to look up (function, class, exported variable).",
        },
        path: {
          type: "string",
          description:
            "Absolute or relative path inside the project to scope to. Omit to search every indexed project.",
        },
      },
    },
  },
  {
    name: "find_duplicates",
    description:
      "**Use when you ask 'where do we have duplicated text across files'** — works on any indexed content (code, runbooks, SOP boilerplate, prompt fragments, copy-pasted doc sections). Pre-refactor, when triaging boilerplate, or auditing for accidental copy-paste. **Beats `grep`** because the comparison is on hashed token-windows, not literal text, so it finds duplicates that aren't byte-identical. Heuristic — labelled as such. Requires `analyzers.background_enabled = true` and `analyzers.duplicates.enabled = true` in config; the response's `disabled` field names which knob is off so an empty `groups` from feature-disabled vs. feature-enabled-but-no-hits is distinguishable. Each group: `hash` and `members` (file_id, start/end line range). When `analyzers.duplicates.semantic = true`, the response also carries `semantic`: embedding-based near-duplicate groups ('same meaning, different text') computed at query time over the stored vectors, each with a cosine `similarity` and chunk members; `semanticDisabled` names the knob when off, and a `truncated` flag plus warning appear when the scan cap cut coverage. Cross-project by default — pass `path` to scope to one project, which you should prefer on large workspaces. Output is capped (top groups by size, members per group). Not useful for finding a specific known duplicate — use `find_literal` or `find_usages` for that.",
    inputSchema: {
      type: "object",
      properties: {
        min_members: {
          type: "integer",
          minimum: 2,
          default: 2,
          description: "Minimum file count for a group to surface.",
        },
        path: {
          type: "string",
          description:
            "Absolute path to scope to one project. Omit to scan every indexed project (can be slow + large on big workspaces).",
        },
      },
    },
  },
  {
    name: "quality_report",
    description:
      "**Use when you ask 'what should we refactor / where is the risky or rotting code in this project'** — one ranked view of every quality signal loctx computes. Stored per-file rules (god-file, long-params, deep-nesting, high-fan-out, stale markdown refs) merge with query-time cross-file rules (extract-candidate duplication across 3+ files, high-fan-in blast radius, low-cohesion mixed-concern files, doc-drift for markdown vs the code it cites). Files rank by severity-weighted finding count (error 3, warning 2, info 1). Per-project: pass `path`; defaults to the sole indexed project when only one exists. `rule` filters to one ruleId (e.g. `quality/god-file`); `limit` caps files (default 20, max 100). **Read `report.notes`** — every coverage cap hit is listed there; treat a capped report as partial. `disabled` names the config knobs when the stored rules haven't run (the cross-file rules run regardless, so the report is partial rather than empty). Heuristic prioritisation for refactoring, not a correctness audit — drill into hits with `find_duplicates`, `find_usages`, or `search_workspace`.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path selecting the project to report on. Optional when exactly one project is indexed.",
        },
        rule: {
          type: "string",
          description: "Only include findings with this exact ruleId (e.g. quality/god-file).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Max files in the report.",
        },
      },
    },
  },
  {
    name: "find_literal",
    description:
      "**Use when you need every occurrence of a literal substring across the indexed workspace** — code, docs, runbooks, prompts, skill files, anything text. E.g. 'every file referencing agents/foo.md', 'every config still pointing at the old URL', 'every runbook mentioning the deprecated escalation contact', 'every prompt that says \"tier-1\"', 'where is the legacy SKU naming still used'. Returns one row per matched line with `relPath`, `line`, `column`, `lineText`, plus surrounding chunk metadata. **Does NOT beat `grep` for safety-critical audits.** The scan operates on indexed chunk text, so chunker gaps (#360) and excluded-by-default directories (`.git`, `node_modules`, build outputs) are blind spots. Use when an indexed-chunk view is sufficient and you want structured per-line responses with chunk context. The response always includes a `coverageNote` — read it. For audit-critical questions ('is this stale phrase referenced anywhere'), supplement with `rg <pattern>` to verify. Complements `search_workspace` (ranked / semantic) and `find_usages` (exact symbol cross-ref). **0-hit semantics:** check `indexHealth.reconciling`. If `true` or `unknown`, retry after the re-index (an `unknown` value means a separate daemon owns reconciliation and its progress is invisible here). If `false`, the substring either isn't in indexed chunks or this workspace isn't indexed (verify with `workspace_status`). Highest-leverage on unfamiliar or large workspaces; for small sets, `rg` may be faster.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description:
            "Literal substring to find. Plain text — SQL LIKE wildcards (% _ \\) are pre-escaped, so an agent can pass the raw user-facing string without escaping.",
        },
        path: {
          type: "string",
          description:
            "Absolute file or directory path to scope the audit. If a project root, the scan stays inside that project. If a subtree, results are further restricted by relPath prefix. Omit to scan every indexed project.",
        },
      },
    },
  },
  {
    name: "refresh_workspace",
    description:
      "**Use when the user mentions recently changing files and you want loctx to see them before the next search.** Triggers a synchronous reconcile pass that prunes deleted files and re-indexes drift. Slow on a cold workspace; usually unnecessary for routine queries (the watcher catches changes live). Returns per-project indexed/skipped/failed counts. Pass `path` to reindex one project; omit to reindex all. Don't call this just because a previous loctx query returned empty — first check `workspace_status` to confirm coverage, then check `indexHealth.reconciling` on a recent response (a `unknown` value means a separate daemon owns reconciliation and its progress isn't observable here).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to a project root. Omit to reindex all.",
        },
      },
    },
  },
] as const;

/**
 * Privileged admin tool. Only listed + dispatchable when `mcp.admin_enabled`
 * is true in config — kept out of the default catalog so an ordinary MCP
 * client never even sees it. Lets a trusted LLM read/write the daemon config
 * and run maintenance, the same operations the admin web UI exposes.
 */
export const ADMIN_TOOL_DEFINITION = {
  name: "admin_workspace",
  description:
    "**Privileged daemon administration — manage loctx itself via your LLM.** Disabled by default; appears only when `mcp.admin_enabled` is set. Dispatches on `action`:\n" +
    "- `get_config`: return every config setting's effective (merged) value, its default, and the config-file path. Call this first to discover valid keys before `set_config`.\n" +
    '- `set_config`: write a `patch` of dot-path keys → values (e.g. `{"maintenance.compactIntervalHours": 12, "analyzers.duplicates.enabled": true}`), validated against the config schema. On the daemon\'s HTTP endpoint the change hot-reloads live (`reloaded: true`); over stdio it lands on disk and applies on the next restart (`reloaded: false`). Some fields (embedding model, daemon port, retrieval mode, watcher) only take effect after a restart even when reloaded.\n' +
    "- `compact`: merge vector-store fragments + prune old version history to reclaim disk; returns before/after/freed bytes. Refused while a reconcile is in flight.\n" +
    "- `backfill_analyzers`: enqueue analyzer enrichment for already-indexed files missing it (optionally scoped to `targets`); returns how many tasks were enqueued.\n" +
    "This is the management counterpart to the read/search tools — use it to tune settings or run upkeep, not to query content.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["get_config", "set_config", "compact", "backfill_analyzers"],
        description: "Which administrative operation to run.",
      },
      patch: {
        type: "object",
        description:
          'For action=set_config: a map of dot-path config keys to new values (e.g. {"maintenance.compactIntervalHours": 12}). Use get_config to list valid keys + current values.',
      },
      targets: {
        type: "array",
        items: { type: "string" },
        description:
          'For action=backfill_analyzers: analyzer names to scope the backfill to (e.g. ["duplicates"]). Omit for all enabled analyzers.',
      },
    },
  },
} as const;

// ---- MCP Server adapter ------------------------------------------------

/**
 * Wire-name → handler map. Single source of truth for `tools/call` dispatch:
 * adding a tool means adding one entry here (and one to TOOL_DEFINITIONS).
 */
const TOOL_HANDLERS = {
  search_workspace: tools.search,
  workspace_status: tools.status,
  refresh_workspace: tools.refresh,
  find_usages: tools.findUsages,
  find_duplicates: tools.findDuplicates,
  quality_report: tools.qualityReport,
  find_literal: tools.findLiteral,
} as const;

type ToolName = keyof typeof TOOL_HANDLERS;

function isToolName(name: string): name is ToolName {
  return name in TOOL_HANDLERS;
}

/**
 * Wire ``tools/list`` and ``tools/call`` onto an MCP {@link Server} so it
 * dispatches into the pure handlers above. Used by both the stdio binary
 * and the SSE route — they share this single registry.
 *
 * `options.reloadConfig`, when supplied, lets the privileged
 * `admin_workspace` tool hot-reload config after a `set_config` write (the
 * in-daemon HTTP transport passes it; the stdio binary doesn't). The admin
 * tool itself is only exposed when `runtime.config.mcp.adminEnabled` is true.
 */
export function registerTools(server: Server, runtime: Runtime, options: AdminOptions = {}): void {
  const adminEnabled = runtime.config.mcp?.adminEnabled === true;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const defs: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }> =
      adminEnabled ? [...TOOL_DEFINITIONS, ADMIN_TOOL_DEFINITION] : TOOL_DEFINITIONS;
    return {
      tools: defs.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();
    try {
      // admin_workspace is dispatched separately so it stays unreachable
      // (404-equivalent) unless explicitly enabled, even if a client guesses
      // the name without it appearing in tools/list.
      if (name === "admin_workspace") {
        if (!adminEnabled) {
          throw new ToolError(
            "admin_workspace is disabled — set mcp.admin_enabled: true in config to allow LLM-driven administration",
          );
        }
        const adminResult = await tools.admin(runtime, args, options);
        const adminText = JSON.stringify(adminResult, null, 2);
        recordMcpRequest(runtime, name, args, {
          responseJson: adminText,
          error: null,
          ok: true,
          elapsedMs: Date.now() - startedAt,
        });
        return { content: [{ type: "text" as const, text: adminText }] };
      }
      if (!isToolName(name)) throw new ToolError(`Unknown tool: ${name}`);
      const handlerResult = await TOOL_HANDLERS[name](runtime, args);
      // Surface swallowed process faults on workspace_status when the
      // stdio server injected a tracker (#452). Kept out of the pure
      // handler so the web transport stays unaffected.
      const result =
        name === "workspace_status" && options.processFaults !== undefined
          ? { ...handlerResult, processFaults: options.processFaults() }
          : handlerResult;
      const text = JSON.stringify(result, null, 2);
      const elapsedMs = Date.now() - startedAt;
      recordMcpRequest(runtime, name, args, {
        responseJson: text,
        error: null,
        ok: true,
        elapsedMs,
      });
      recordUsageValue(runtime, name, result, elapsedMs);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordMcpRequest(runtime, name, args, {
        responseJson: null,
        error: message,
        ok: false,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  });
}

/**
 * Persist one `tools/call` to the request log for the admin Logs page.
 * Best-effort: a logging failure (or a non-serializable argument blob)
 * must never bubble into the tool response, so everything here is
 * swallowed. Skipped when `mcp.logMaxRows` is 0 (logging disabled).
 */
function recordMcpRequest(
  runtime: Runtime,
  tool: string,
  args: unknown,
  outcome: {
    readonly responseJson: string | null;
    readonly error: string | null;
    readonly ok: boolean;
    readonly elapsedMs: number;
  },
): void {
  // Read defensively: logging is observability, and a runtime assembled
  // without an `mcp` config section (older callers, test fixtures) must
  // still serve tool calls. Absent config => logging off.
  const maxRows = runtime.config.mcp?.logMaxRows ?? 0;
  if (maxRows <= 0) return;
  // Fire-and-forget (#452): defer both the JSON.stringify(args) and the
  // synchronous SQLite write to the next tick so the tool response
  // returns first. Logging must never add latency to the response
  // critical path. `args`/`outcome` aren't mutated after the handler
  // returns, so serializing on the next tick is safe.
  setImmediate(() => {
    try {
      let argumentsJson: string;
      try {
        argumentsJson = JSON.stringify(args ?? {});
      } catch {
        argumentsJson = '"<unserializable arguments>"';
      }
      runtime.state.logMcpRequest({ tool, argumentsJson, ...outcome }, maxRows);
    } catch {
      // Logging is observability, not correctness — never fail a tool call
      // because the request couldn't be recorded.
    }
  });
}

/**
 * Estimate and persist the "value served" of a retrieval response
 * (#value-metrics) — tokens saved vs. a grep+read baseline, reads avoided.
 * Only the file-backed retrieval tools have a baseline. Fire-and-forget on
 * the next tick so it never adds latency, and fully swallowed: a value
 * metric must never break a tool call.
 */
function recordUsageValue(
  runtime: Runtime,
  tool: string,
  result: unknown,
  elapsedMs: number,
): void {
  if (!isValueTool(tool)) return;
  setImmediate(() => {
    try {
      const value = estimateQueryValue(tool, result, (projectId, relPath) => {
        const file = runtime.state.getFile(projectId as ProjectId, relPath);
        return file?.size ?? null;
      });
      runtime.state.applyUsageDeltas(toUsageDeltas(value, elapsedMs));
    } catch {
      // Accounting is observability, not correctness.
    }
  });
}
