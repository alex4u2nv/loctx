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
      analyzers: {
        backgroundEnabled: true,
        duplicates: { enabled: true },
      },
    },
    discovery: {
      discoverProjects: () => projects,
      discoverWithMarkers: () =>
        projects.map((p) => ({ project: p, marker: ".git", markerKind: "git" })),
      resolveProject: (path: string) =>
        projects.find((p) => path.startsWith(p.root)) ?? null,
      findAbsorbedMarkers: () => [],
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
      findSymbol: () => ({ defs: [], refs: [] }),
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
    reconciler: {
      status: () => ({
        running: false,
        startedAt: null,
        currentProjectName: null,
        completed: 0,
        total: 0,
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

  // The descriptions are the user-facing API for agent tool selection.
  // Past bug: an agent that wanted "show me every occurrence of
  // path/foo.md" reached for grep because search_workspace was
  // described as "semantic" — the agent didn't realize the lexical
  // branch could match path tokens. We now state the boundary
  // explicitly so the agent knows when to use which tool. These
  // assertions pin the boundary copy so a future doc edit can't
  // silently drop the routing signal.
  it("search_workspace description routes literal-string queries to grep", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "search_workspace");
    expect(tool?.description).toMatch(/ranked/i);
    // Names both the use-cases it handles and the use-case it doesn't.
    expect(tool?.description).toMatch(/conceptual|semantic/i);
    expect(tool?.description).toMatch(/coverage/i);
    expect(tool?.description).toMatch(/\bnot\b.*exhaustive|grep|ripgrep|\brg\b/i);
  });

  it("find_usages description routes file-path / literal-text queries away", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "find_usages");
    expect(tool?.description).toMatch(/exact/i);
    expect(tool?.description).toMatch(/symbol/i);
    expect(tool?.description).toMatch(/\bnot\b.*file path|paths|literal/i);
  });
});

// ---- indexHealth surfacing (#43) -----------------------------------

describe("indexHealth surfacing", () => {
  function reconcilingRuntime(): Runtime {
    return stubRuntime({
      reconciler: {
        status: () => ({
          running: true,
          startedAt: "2026-05-17T22:57:31.185Z",
          currentProjectName: "loctx",
          completed: 0,
          total: 7,
        }),
      } as Runtime["reconciler"],
    });
  }

  it("search response carries indexHealth from the reconciler", async () => {
    const out = await tools.search(reconcilingRuntime(), { query: "x" });
    expect(out.indexHealth.reconciling).toBe(true);
    expect(out.indexHealth.currentProject).toBe("loctx");
    expect(out.indexHealth.completed).toBe(0);
    expect(out.indexHealth.total).toBe(7);
  });

  it("status response carries indexHealth", async () => {
    const out = await tools.status(reconcilingRuntime(), {});
    expect(out.indexHealth.reconciling).toBe(true);
    expect(out.indexHealth.currentProject).toBe("loctx");
  });

  it("find_usages response carries indexHealth", async () => {
    const out = await tools.findUsages(reconcilingRuntime(), { symbol: "WorkspaceSearcher" });
    expect(out.indexHealth.reconciling).toBe(true);
  });

  it("find_duplicates response carries indexHealth", async () => {
    const out = await tools.findDuplicates(reconcilingRuntime(), {});
    expect(out.indexHealth.reconciling).toBe(true);
  });

  it("refresh response carries indexHealth", async () => {
    const out = await tools.refresh(reconcilingRuntime(), {});
    expect(out.indexHealth.reconciling).toBe(true);
  });

  it("idle reconciler reports reconciling=false", async () => {
    const out = await tools.search(stubRuntime(), { query: "x" });
    expect(out.indexHealth.reconciling).toBe(false);
    expect(out.indexHealth.currentProject).toBeNull();
  });

  it("find_duplicates reports disabled=null when both knobs are on", async () => {
    const out = await tools.findDuplicates(stubRuntime(), {});
    expect(out.disabled).toBeNull();
    expect(out.groups).toEqual([]);
  });

  it("find_duplicates names backgroundEnabled when it's off", async () => {
    const runtime = stubRuntime({
      config: {
        ...(stubRuntime().config as Runtime["config"]),
        analyzers: {
          backgroundEnabled: false,
          duplicates: { enabled: true },
        },
      } as Runtime["config"],
    });
    const out = await tools.findDuplicates(runtime, {});
    expect(out.disabled).toMatch(/backgroundEnabled/);
  });

  it("find_duplicates names duplicates.enabled when only that knob is off", async () => {
    const runtime = stubRuntime({
      config: {
        ...(stubRuntime().config as Runtime["config"]),
        analyzers: {
          backgroundEnabled: true,
          duplicates: { enabled: false },
        },
      } as Runtime["config"],
    });
    const out = await tools.findDuplicates(runtime, {});
    expect(out.disabled).toMatch(/duplicates\.enabled/);
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

  it("clamps an out-of-range limit to [1, 1000] (#344)", async () => {
    const captured: Array<{ limit?: number }> = [];
    const runtime = stubRuntime({
      searcher: {
        search: async (req) => {
          captured.push(req as { limit?: number });
          return {
            resolvedScope: { mode: "all", project: null, relPrefix: null, inputPath: null },
            results: [],
            warnings: [],
          };
        },
      } as Runtime["searcher"],
    });
    await tools.search(runtime, { query: "x", limit: 0 });
    await tools.search(runtime, { query: "x", limit: 999_999 });
    expect(captured[0]?.limit).toBe(1);
    expect(captured[1]?.limit).toBe(1000);
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
