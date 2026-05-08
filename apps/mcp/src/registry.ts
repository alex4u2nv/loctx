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

import { type Runtime, type Scope, type SearchResponse, Validator } from "@loctx/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ---- input / output types ----------------------------------------------

export interface SearchInput {
  readonly query: string;
  readonly cwd?: string;
  readonly scope?: Scope;
  readonly limit?: number;
  readonly language?: string;
}

export interface StatusInput {
  readonly include_indexed_counts?: boolean;
}

export interface RefreshInput {
  readonly path?: string;
}

export interface StatusOutput {
  readonly configPath: string | null;
  readonly paths: Runtime["config"]["paths"];
  readonly embedding: Runtime["config"]["embedding"];
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<{ id: string; name: string; root: string }>;
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
      ...(v.getStr(data, "cwd") !== undefined ? { cwd: v.getStr(data, "cwd") as string } : {}),
      scope: (v.getStr(data, "scope") as Scope | undefined) ?? "auto",
      limit: v.getInt(data, "limit", { nonNegative: true }) ?? 10,
      ...(v.getStr(data, "language") !== undefined
        ? { language: v.getStr(data, "language") as string }
        : {}),
    });
  },

  async status(runtime: Runtime, input: unknown): Promise<StatusOutput> {
    const v = new Validator(ToolError, "workspace_status");
    const data = v.requireRecord(input ?? {}, "arguments");
    const includeCounts = v.getBool(data, "include_indexed_counts") ?? false;

    const projects = runtime.discovery.discoverProjects();
    const baseline: StatusOutput = {
      configPath: runtime.config.source ?? null,
      paths: runtime.config.paths,
      embedding: runtime.config.embedding,
      workspaceRoots: runtime.config.workspaceRoots,
      projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root })),
    };
    if (!includeCounts) return baseline;

    return {
      ...baseline,
      indexedFileCounts: Object.freeze(
        Object.fromEntries(
          projects.map((p) => [p.id, runtime.state.listFiles(p.id).length] as const),
        ),
      ),
    };
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
      "Semantic search over the locally-indexed workspace. Returns ranked code chunks with paths, line ranges, scores, and snippets.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural-language or code-fragment query." },
        cwd: {
          type: "string",
          description: "Override working directory used for scope resolution.",
        },
        scope: {
          type: "string",
          enum: ["auto", "project", "subtree", "all"],
          default: "auto",
          description:
            "auto: nearest project from cwd. project: same. subtree: project + path prefix. all: every indexed project.",
        },
        limit: { type: "integer", minimum: 1, default: 10 },
        language: {
          type: "string",
          description: "Filter results to a single language (python, typescript, go, ...).",
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
      const result = await dispatch(runtime, name, args);
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

async function dispatch(runtime: Runtime, name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case "search_workspace":
      return tools.search(runtime, args);
    case "workspace_status":
      return tools.status(runtime, args);
    case "refresh_workspace":
      return tools.refresh(runtime, args);
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}
