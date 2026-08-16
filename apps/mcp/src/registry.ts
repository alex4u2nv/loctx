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
  ReconcileInFlightError,
  type Runtime,
  readActiveDaemon,
  resolveProjectScope,
  resolveUnderWorkspaceRoots,
  runQualityReport,
  runSemanticDuplicates,
  summarizeUsage,
  toUsageDeltas,
  Validator,
  writeConfigPatch,
} from "@loctx/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ADMIN_TOOL_DEFINITION, TOOL_DEFINITIONS } from "./tool-definitions.js";
import type {
  AdminAction,
  AdminConfigSetting,
  AdminOptions,
  AdminOutput,
  FindDuplicatesOutput,
  FindLiteralOutput,
  FindUsagesOutput,
  IndexHealth,
  LiteralMatchHit,
  ProjectStatusEntry,
  QualityReportOutput,
  RefreshOutput,
  RefreshOutputWithHealth,
  SearchOutput,
  StatusOutput,
} from "./tool-outputs.js";

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

export { ADMIN_TOOL_DEFINITION, TOOL_DEFINITIONS } from "./tool-definitions.js";
// Re-exports (#542 split): existing importers keep working through
// registry.ts.
export * from "./tool-outputs.js";
