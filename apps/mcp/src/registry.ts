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

import {
  type DuplicateGroup,
  type ProjectId,
  type Runtime,
  type SearchResponse,
  type SymbolRefHit,
  Validator,
  inventoryProjects,
} from "@loctx/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
 */
export interface IndexHealth {
  readonly reconciling: boolean;
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
  readonly indexHealth: IndexHealth;
}

export interface FindDuplicatesInput {
  /** Minimum file count for a group to surface. Default 2. */
  readonly minMembers?: number;
}

export interface FindDuplicatesOutput {
  readonly groups: ReadonlyArray<DuplicateGroup>;
  readonly indexHealth: IndexHealth;
  /**
   * Non-null when the duplicate-detection analyzer is disabled in
   * config — surfaces *why* `groups` is empty so an agent can tell
   * "feature off" from "feature on, nothing found." Names the
   * exact config knob the user would flip to enable it.
   */
  readonly disabled: string | null;
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

export class ToolError extends Error {}

function currentIndexHealth(runtime: Runtime): IndexHealth {
  const s = runtime.reconciler.status();
  return Object.freeze({
    reconciling: s.running,
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

    const query = v.getStr(data, "query");
    if (!query) throw new ToolError("query is required and must be a non-empty string");

    // Match the HTTP /api/search bounds (#326-era). Without an upper
    // bound, an agent passing `limit: 1_000_000` could ask the
    // searcher for a million rows and OOM the daemon — same Searcher
    // is shared with the admin search where it's already bounded.
    // Lower bound 1 (not 0) so callers don't accidentally request an
    // empty payload and assume "no results".
    const rawLimit = v.getInt(data, "limit", { nonNegative: true }) ?? 10;
    const limit = Math.min(Math.max(1, rawLimit), 1000);

    const response = await runtime.searcher.search({
      query,
      ...(v.getStr(data, "path") !== undefined ? { path: v.getStr(data, "path") as string } : {}),
      limit,
      ...(v.getStr(data, "language") !== undefined
        ? { language: v.getStr(data, "language") as string }
        : {}),
      ...(v.getBool(data, "coverage") === true ? { coverage: true } : {}),
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
    const symbol = v.getStr(data, "symbol");
    if (!symbol) throw new ToolError("symbol is required and must be a non-empty string");
    const path = v.getStr(data, "path");

    // Scope: if path given, narrow to one project. Otherwise sweep all.
    let projects = runtime.discovery.discoverProjects();
    if (path !== undefined) {
      const scoped = runtime.discovery.resolveProject(path);
      if (scoped === null) {
        throw new ToolError(
          `path ${path} is not inside any indexed project; omit path to search every project.`,
        );
      }
      projects = [scoped];
    }

    const out: Array<{
      readonly projectId: string;
      readonly projectName: string;
      readonly defs: ReadonlyArray<SymbolRefHit>;
      readonly refs: ReadonlyArray<SymbolRefHit>;
    }> = [];
    for (const project of projects) {
      const { defs, refs } = runtime.state.findSymbol(project.id, symbol);
      if (defs.length === 0 && refs.length === 0) continue;
      out.push({ projectId: project.id, projectName: project.name, defs, refs });
    }
    return Object.freeze({
      symbol,
      projects: Object.freeze(out),
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
        "analyzers.backgroundEnabled is false in config — enable it and restart the daemon.";
    } else if (!an.duplicates.enabled) {
      disabled =
        "analyzers.duplicates.enabled is false in config — enable it and restart the daemon.";
    }
    const groups = runtime.state.findDuplicateGroups(Math.max(2, minMembers));
    return Object.freeze({
      groups: Object.freeze(groups),
      indexHealth: currentIndexHealth(runtime),
      disabled,
    });
  },

  async findLiteral(runtime: Runtime, input: unknown): Promise<FindLiteralOutput> {
    const v = new Validator(ToolError, "find_literal");
    const data = v.requireRecord(input ?? {}, "arguments");
    const pattern = v.getStr(data, "pattern");
    if (pattern === undefined || pattern === "") {
      throw new ToolError("pattern is required and must be a non-empty string");
    }
    if (pattern.length > 1024) {
      throw new ToolError("pattern exceeds 1024-char limit");
    }
    const path = v.getStr(data, "path");

    let projectId: ProjectId | undefined;
    let relPathPrefix: string | undefined;
    if (path !== undefined && path !== "") {
      const scoped = runtime.discovery.resolveProject(path);
      if (scoped === null) {
        throw new ToolError(
          `path ${path} is not inside any indexed project; omit path to search every project.`,
        );
      }
      projectId = scoped.id;
      // If path is deeper than the project root, narrow further by
      // prefix. resolveProject returns the project; we re-derive the
      // sub-prefix from the input path.
      if (path.startsWith(`${scoped.root}/`)) {
        relPathPrefix = path.slice(scoped.root.length + 1);
      }
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
      indexHealth: currentIndexHealth(runtime),
      coverageNote:
        "Scans indexed chunk text. Lines outside any chunk (chunker gaps — see issue #360) are not searched. For total file coverage, supplement with `rg <pattern>`.",
    });
  },

  async refresh(runtime: Runtime, input: unknown): Promise<RefreshOutputWithHealth> {
    const v = new Validator(ToolError, "refresh_workspace");
    const data = v.requireRecord(input ?? {}, "arguments");
    const path = v.getStr(data, "path");

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
} as const;

// ---- tool catalog ------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    name: "search_workspace",
    description:
      "**Ranked** code search over the locally-indexed workspace, fused from vector (semantic) + lexical FTS5. Returns the top-N highest-scoring code chunks. Use this for: conceptual queries ('where do we debounce websocket reconnects'), code-fragment lookups ('rt.indexer.indexProject'), symbol-name searches when you also want context, and refactor-coverage mode (`coverage: true`). **Not** the right tool for exhaustive literal-string enumeration ('every file that contains `agents/foo.md`') — the lexical branch tokenizes path-like strings into their segments, so it returns ranked partial-match chunks, not the grep-style file list you'd get with `rg 'agents/foo.md'`. For exact-symbol cross-references (no fuzz), prefer `find_usages`. Each result carries `absPath`, `relPath`, `projectRoot`, `projectName`, line range, score, snippet, `matchReasons`, `analyzer` (AST metadata), and `sources` (vector|lexical). Pass `path` to scope to a project or subtree; omit to search everywhere. The response's `indexHealth.reconciling` field signals partial results when a re-index is in flight.",
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
      "Discovered projects, configured workspace roots, embedding identity, and storage paths. Optionally includes per-project indexed file counts.",
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
      "**Exact** cross-reference lookup for a *code symbol* (function, class, exported identifier). Returns the symbol's definitions plus every callsite/import — no ranking, no fuzz, no token splitting. Each hit carries `relPath`, `line` (the exact reference), `chunkStartLine`/`chunkEndLine` (surrounding chunk), and `kind` (`def`|`call`|`import`|`reference`). This is the right tool when the question is 'where is X used/defined' and X is a real identifier. **Not** the right tool for file paths or arbitrary literal strings — pass those to `search_workspace` (ranked) or fall back to `rg`/`grep` for exhaustive enumeration. Pass `path` to scope to one project; omit to search every project that knows the symbol. The response carries an `indexHealth` field — when `indexHealth.reconciling` is true a symbol may be missing because its file hasn't been re-indexed yet, not because the symbol is undefined; retry after the pass completes.",
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
      "Cross-file duplicate-code detection. Returns groups where the same token-window appears in 2+ files. Heuristic — labelled as such. Requires `analyzers.backgroundEnabled = true` and `analyzers.duplicates.enabled = true` in config. The response's `disabled` field is non-null with the specific reason when either knob is off, so an empty `groups` from feature-disabled vs. feature-enabled-but-no-hits is distinguishable. Each group: `hash` and `members` (file_id, start/end line range).",
    inputSchema: {
      type: "object",
      properties: {
        min_members: {
          type: "integer",
          minimum: 2,
          default: 2,
          description: "Minimum file count for a group to surface.",
        },
      },
    },
  },
  {
    name: "find_literal",
    description:
      "**Audit-shape** literal-substring search across indexed chunk text. Returns *every* line that contains `pattern` — no ranking, no token splitting, no embedding. Use this for audits where exhaustiveness matters: 'every file referencing agents/foo.md', 'every config still pointing at the old URL', 'where is the deprecated constant still used'. Complements `search_workspace` (ranked / semantic) and `find_usages` (exact symbol cross-ref). Each hit carries `relPath`, `line`, `column`, `lineText`, and the surrounding chunk's `chunkStartLine`/`chunkEndLine`. Coverage caveat: scans indexed chunk text, so chunker gaps (#360) are blind spots — the response always includes a `coverageNote` reminding callers to supplement with `rg` for total file coverage when the audit is safety-critical.",
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
      "Reindex one project (when path is given) or every discovered project. Returns per-project indexed/skipped/failed counts.",
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
 */
export function registerTools(server: Server, runtime: Runtime): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (!isToolName(name)) throw new ToolError(`Unknown tool: ${name}`);
      const result = await TOOL_HANDLERS[name](runtime, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  });
}
