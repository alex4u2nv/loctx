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
  readonly status: "active" | "orphaned";
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

export interface StatusOutput {
  readonly configPath: string | null;
  readonly paths: Runtime["config"]["paths"];
  readonly embedding: Runtime["config"]["embedding"];
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<ProjectStatusEntry>;
  readonly indexedFileCounts?: Readonly<Record<string, number>>;
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
}

export class ToolError extends Error {}

// ---- pure handlers -----------------------------------------------------

export const tools = {
  async search(runtime: Runtime, input: unknown): Promise<SearchResponse> {
    const v = new Validator(ToolError, "search_workspace");
    const data = v.requireRecord(input ?? {}, "arguments");

    const query = v.getStr(data, "query");
    if (!query) throw new ToolError("query is required and must be a non-empty string");

    return runtime.searcher.search({
      query,
      ...(v.getStr(data, "path") !== undefined ? { path: v.getStr(data, "path") as string } : {}),
      limit: v.getInt(data, "limit", { nonNegative: true }) ?? 10,
      ...(v.getStr(data, "language") !== undefined
        ? { language: v.getStr(data, "language") as string }
        : {}),
      ...(v.getBool(data, "coverage") === true ? { coverage: true } : {}),
    });
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
    const baseline: StatusOutput = {
      configPath: runtime.config.source ?? null,
      paths: runtime.config.paths,
      embedding: runtime.config.embedding,
      workspaceRoots: runtime.config.workspaceRoots,
      projects: entries,
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
    return Object.freeze({ symbol, projects: Object.freeze(out) });
  },

  async refresh(runtime: Runtime, input: unknown): Promise<RefreshOutput> {
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
    return { summaries: Object.freeze(summaries) };
  },
} as const;

// ---- tool catalog ------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    name: "search_workspace",
    description:
      "Semantic search over the locally-indexed workspace. Returns ranked code chunks. Each result includes `absPath` (absolute path on disk), `relPath` (relative to project root), `projectRoot`, `projectName`, line range, score, snippet, `matchReasons` (e.g. symbol_match, import_match, call_match, risky_call_category, complexity_signal, async_match) and `analyzer` (cheap AST metadata: imports, exports, calls, complexity, risky-call categories). `analyzer` is null for non-code chunks. Pass `path` to scope the search; omit it to search every indexed project.",
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
      "Cross-reference lookup for a symbol: returns its definitions and every callsite/import. Distinct from `search_workspace` because it is exact-match by name, not ranked retrieval. Each hit carries `relPath`, `line` (the exact reference), `chunkStartLine`/`chunkEndLine` (surrounding chunk), and `kind` (`def`|`call`|`import`|`reference`). Pass `path` to scope to one project; omit to search every project that knows the symbol.",
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
