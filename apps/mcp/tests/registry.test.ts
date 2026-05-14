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
      projectSource: null,
      sources: {},
      workspaceRoots: ["/ws"] as ReadonlyArray<string>,
      paths: {
        dataDir: "/data",
        configDir: "/cfg",
        vectorDir: "/data/vectors",
        stateDb: "/data/state.sqlite3",
        logsDir: "/data/logs",
      },
      embedding: { provider: "fake", model: "hash", normalize: true },
      watcher: { debounceMs: 300 },
      daemon: { port: 3000, hostname: "localhost" },
    },
    discovery: {
      discoverProjects: () => projects,
      discoverWithMarkers: () =>
        projects.map((p) => ({ project: p, marker: ".git", markerKind: "git" })),
      resolveProject: (path: string) =>
        projects.find((p) => path.startsWith(p.root)) ?? null,
      configuredRoots: ["/ws"] as ReadonlyArray<string>,
    },
    state: {
      listFiles: (id: string) => (id === "proj-a" ? [{}, {}, {}] : [{}]),
      listProjects: () =>
        projects.map((p) => ({
          ...p,
          lastIndexedAt: "2026-05-08T00:00:00.000Z",
          lastReconciledAt: null,
          active: true,
        })),
      findDuplicateGroups: () => [],
    },
    searcher: {
      search: async () => ({
        resolvedScope: { mode: "all", project: null, relPrefix: null, inputPath: null },
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
  it("exposes the five loctx tools", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      "search_workspace",
      "workspace_status",
      "find_usages",
      "find_duplicates",
      "refresh_workspace",
    ]);
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
            resolvedScope: { mode: "project", project: null, relPrefix: null, inputPath: null },
            results: [],
            warnings: [],
          };
        },
      } as Runtime["searcher"],
    });
    await tools.search(runtime, {
      query: "hello",
      path: "/ws/alpha/src",
      limit: 3,
    });
    expect(captured).toMatchObject({ query: "hello", path: "/ws/alpha/src", limit: 3 });
  });

  it("defaults limit to 10 and omits path when caller doesn't provide one", async () => {
    let captured: { path?: string; limit?: number } = {};
    const runtime = stubRuntime({
      searcher: {
        search: async (req) => {
          captured = req as { path?: string; limit?: number };
          return {
            resolvedScope: { mode: "all", project: null, relPrefix: null, inputPath: null },
            results: [],
            warnings: [],
          };
        },
      } as Runtime["searcher"],
    });
    await tools.search(runtime, { query: "x" });
    expect(captured.path).toBeUndefined();
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

// ---- find_usages (#96) ---------------------------------------------

describe("tools.findUsages", () => {
  function runtimeWithSymbol(
    perProject: Record<
      string,
      {
        defs: ReadonlyArray<{ relPath: string; line: number }>;
        refs: ReadonlyArray<{ relPath: string; line: number }>;
      }
    >,
  ): Runtime {
    return stubRuntime({
      state: {
        findSymbol: (id: string) => {
          const data = perProject[id] ?? { defs: [], refs: [] };
          return {
            defs: data.defs.map((d) => ({
              symbol: "anything",
              projectId: id,
              fileId: "f",
              chunkId: "c",
              line: d.line,
              kind: "def" as const,
              relPath: d.relPath,
              chunkStartLine: d.line,
              chunkEndLine: d.line + 4,
            })),
            refs: data.refs.map((r) => ({
              symbol: "anything",
              projectId: id,
              fileId: "f",
              chunkId: "c",
              line: r.line,
              kind: "call" as const,
              relPath: r.relPath,
              chunkStartLine: r.line,
              chunkEndLine: r.line + 4,
            })),
          };
        },
        listFiles: () => [],
        listProjects: () => [],
      } as unknown as Runtime["state"],
    });
  }

  it("requires the symbol argument", async () => {
    const runtime = stubRuntime();
    await expect(tools.findUsages(runtime, {})).rejects.toBeInstanceOf(ToolError);
  });

  it("returns per-project defs + refs across every project that knows the symbol", async () => {
    const runtime = runtimeWithSymbol({
      "proj-a": { defs: [{ relPath: "src/auth.ts", line: 1 }], refs: [] },
      "proj-b": { defs: [], refs: [{ relPath: "src/login.ts", line: 12 }] },
    });
    const out = await tools.findUsages(runtime, { symbol: "authenticateUser" });
    expect(out.symbol).toBe("authenticateUser");
    expect(out.projects).toHaveLength(2);
    const a = out.projects.find((p) => p.projectId === "proj-a");
    const b = out.projects.find((p) => p.projectId === "proj-b");
    expect(a?.defs[0]?.relPath).toBe("src/auth.ts");
    expect(b?.refs[0]?.line).toBe(12);
  });

  it("scopes to one project when path is given", async () => {
    const runtime = runtimeWithSymbol({
      "proj-a": { defs: [{ relPath: "src/x.ts", line: 1 }], refs: [] },
      "proj-b": { defs: [{ relPath: "src/y.ts", line: 1 }], refs: [] },
    });
    const out = await tools.findUsages(runtime, {
      symbol: "foo",
      path: "/ws/alpha/src",
    });
    expect(out.projects.map((p) => p.projectId)).toEqual(["proj-a"]);
  });

  it("rejects a path that resolves outside every indexed project", async () => {
    const runtime = runtimeWithSymbol({});
    await expect(
      tools.findUsages(runtime, { symbol: "foo", path: "/elsewhere" }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("omits projects with no defs and no refs", async () => {
    const runtime = runtimeWithSymbol({
      "proj-a": { defs: [{ relPath: "src/a.ts", line: 1 }], refs: [] },
      "proj-b": { defs: [], refs: [] },
    });
    const out = await tools.findUsages(runtime, { symbol: "foo" });
    expect(out.projects.map((p) => p.projectId)).toEqual(["proj-a"]);
  });
});
