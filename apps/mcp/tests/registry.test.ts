import type { Runtime, SearchResponse } from "@loctx/core";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS, ToolError, tools } from "../src/registry.js";

// ---- minimal stubs --------------------------------------------------

function stubRuntime(overrides: Partial<Runtime> = {}): Runtime {
  const projects = [
    { id: "proj-a", name: "alpha", root: "/ws/alpha" },
    { id: "proj-b", name: "beta", root: "/ws/beta" },
  ];

  const baseline = {
    config: {
      source: "/cfg/loctx/config.yaml",
      workspaceRoots: ["/ws"] as ReadonlyArray<string>,
      paths: {
        dataDir: "/data",
        configDir: "/cfg",
        chromaDir: "/data/chroma",
        stateDb: "/data/state.sqlite3",
        logsDir: "/data/logs",
      },
      embedding: { provider: "fake", model: "hash", normalize: true },
      watcher: { debounceMs: 300 },
    },
    discovery: {
      discoverProjects: () => projects,
      resolveProject: (path: string) =>
        projects.find((p) => path.startsWith(p.root)) ?? null,
      configuredRoots: ["/ws"] as ReadonlyArray<string>,
    },
    state: {
      listFiles: (id: string) => (id === "proj-a" ? [{}, {}, {}] : [{}]),
    },
    searcher: {
      search: async () => ({
        resolvedScope: { mode: "all", project: null, relPrefix: null },
        results: [
          {
            projectId: "proj-a",
            relPath: "src/app.ts",
            startLine: 1,
            endLine: 10,
            score: 0.9,
            snippet: "function hello() {}",
            language: "typescript",
            kind: "function",
            symbols: ["hello"],
          },
        ],
        warnings: [],
      }) satisfies (req: unknown) => Promise<SearchResponse>,
    },
    indexer: {
      indexProject: async (project: { id: string }) => ({
        project: { id: project.id, name: "x", root: "/x" },
        indexed: 5,
        skipped: 2,
        failed: 0,
        elapsedSeconds: 0.5,
        failures: [],
        total: 7,
      }),
    },
    rules: {},
    embeddings: {},
    vectors: {},
    close: () => undefined,
  };

  return { ...baseline, ...overrides } as unknown as Runtime;
}

// ---- tool catalog ---------------------------------------------------

describe("TOOL_DEFINITIONS", () => {
  it("exposes the three loctx tools", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(["search_workspace", "workspace_status", "refresh_workspace"]);
  });

  it("every tool has an inputSchema with type=object", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

// ---- search ---------------------------------------------------------

describe("tools.search", () => {
  it("requires a query argument", async () => {
    const runtime = stubRuntime();
    await expect(tools.search(runtime, {})).rejects.toBeInstanceOf(ToolError);
  });

  it("forwards query + scope + limit to the searcher", async () => {
    let captured: unknown;
    const runtime = stubRuntime({
      searcher: {
        search: async (req) => {
          captured = req;
          return {
            resolvedScope: { mode: "project", project: null, relPrefix: null },
            results: [],
            warnings: [],
          };
        },
      } as Runtime["searcher"],
    });
    await tools.search(runtime, { query: "hello", scope: "project", limit: 3 });
    expect(captured).toMatchObject({ query: "hello", scope: "project", limit: 3 });
  });

  it("defaults scope to auto and limit to 10", async () => {
    let captured: { scope?: string; limit?: number } = {};
    const runtime = stubRuntime({
      searcher: {
        search: async (req) => {
          captured = req as { scope?: string; limit?: number };
          return { resolvedScope: { mode: "all", project: null, relPrefix: null }, results: [], warnings: [] };
        },
      } as Runtime["searcher"],
    });
    await tools.search(runtime, { query: "x" });
    expect(captured.scope).toBe("auto");
    expect(captured.limit).toBe(10);
  });
});

// ---- status ---------------------------------------------------------

describe("tools.status", () => {
  it("returns baseline workspace info without counts by default", async () => {
    const runtime = stubRuntime();
    const out = await tools.status(runtime, {});
    expect(out.projects.length).toBe(2);
    expect(out.indexedFileCounts).toBeUndefined();
  });

  it("includes per-project file counts when requested", async () => {
    const runtime = stubRuntime();
    const out = await tools.status(runtime, { include_indexed_counts: true });
    expect(out.indexedFileCounts).toEqual({ "proj-a": 3, "proj-b": 1 });
  });
});

// ---- refresh --------------------------------------------------------

describe("tools.refresh", () => {
  it("reindexes every discovered project when path is omitted", async () => {
    const runtime = stubRuntime();
    const out = await tools.refresh(runtime, {});
    expect(out.summaries.length).toBe(2);
    expect(out.summaries[0]?.indexed).toBe(5);
  });

  it("reindexes a single project when path resolves", async () => {
    const runtime = stubRuntime();
    const out = await tools.refresh(runtime, { path: "/ws/alpha/src/x.ts" });
    expect(out.summaries.length).toBe(1);
    expect(out.summaries[0]?.projectId).toBe("proj-a");
  });

  it("returns no summaries when the path does not match any project", async () => {
    const runtime = stubRuntime();
    const out = await tools.refresh(runtime, { path: "/elsewhere/x" });
    expect(out.summaries).toEqual([]);
  });
});
