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
      // #357: literal-substring audit tool. Default stub returns
      // empty; individual tests override with `state: { ... }`.
      findLiteralMatches: () => [],
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
    rules: {
      ignoredDirs: new Set([".git", "node_modules"]),
      noiseGlobs: ["package-lock.json", "pnpm-lock.yaml"],
      secretGlobs: [".env", "*.pem"],
      allowedNamedFiles: new Set(["Pipfile.lock"]),
    },
    embeddings: {},
    vectors: {},
    close: () => undefined,
  };

  return { ...baseline, ...overrides } as unknown as Runtime;
}

// ---- tool catalog ---------------------------------------------------

describe("TOOL_DEFINITIONS", () => {
  it("exposes the six loctx tools", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      "search_workspace",
      "workspace_status",
      "find_usages",
      "find_duplicates",
      "find_literal",
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

  it("find_literal description names audit-shape questions + coverage caveat", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "find_literal");
    expect(tool?.description).toMatch(/audit/i);
    expect(tool?.description).toMatch(/exhaustiv|every/i);
    expect(tool?.description).toMatch(/literal|substring/i);
    expect(tool?.description).toMatch(/coverage|#360/i);
  });

  // Framing pins from #370: every tool description should LEAD with a
  // trigger ("Use when ...") or, for workspace_status, a "call me first"
  // directive. The previous descriptions opened with the return shape,
  // and an empirical replay showed agents skipping loctx entirely
  // because they never noticed they'd hit a triggering signal.
  it("workspace_status leads with a pre-flight directive", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "workspace_status");
    // First sentence (up to first period) must announce the trigger.
    const firstSentence = tool?.description.split(". ")[0] ?? "";
    expect(firstSentence).toMatch(/pre-flight|call.*first|call.*once|before/i);
    // Names the fallback so agents know what to do if the repo isn't listed.
    expect(tool?.description).toMatch(/grep|find\b/i);
  });

  // Pin the natural-language framing. loctx indexes more than code —
  // runbooks, prompts, skill files, business-process docs — and agents
  // were observed routing those queries to grep because the tool
  // descriptions read as code-only. search_workspace and find_literal
  // must explicitly name non-code content classes so an agent doing
  // "where is the vendor-onboarding process documented" can recognize
  // the trigger.
  it("search_workspace + find_literal advertise non-code content (#226 alignment)", () => {
    const NON_CODE_HINTS = /docs?|runbook|prompt|skill|process|workflow|business/i;
    const search = TOOL_DEFINITIONS.find((t) => t.name === "search_workspace");
    expect(search?.description, "search_workspace must name non-code content").toMatch(
      NON_CODE_HINTS,
    );
    const literal = TOOL_DEFINITIONS.find((t) => t.name === "find_literal");
    expect(literal?.description, "find_literal must name non-code content").toMatch(NON_CODE_HINTS);
  });

  it("retrieval tools open with 'Use when' triggers (#370)", () => {
    for (const name of ["search_workspace", "find_usages", "find_literal", "find_duplicates"]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
      expect(tool?.description, `${name} should open with 'Use when'`).toMatch(/^\*?\*?Use when/i);
    }
  });

  it("symbol/literal tools state 0-hit semantics so agents don't silently fall back (#370 #4)", () => {
    for (const name of ["find_usages", "find_literal"]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
      expect(tool?.description, `${name} must mention 0-hit / reconciling semantics`).toMatch(
        /0-hit|reconciling/i,
      );
    }
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

  it("surfaces exclusion rules so agents know what's NOT covered (#371)", async () => {
    const runtime = stubRuntime();
    const out = await tools.status(runtime, {});
    // ignoredDirs comes through as a sorted array (not the underlying Set).
    expect(out.exclusions.ignoredDirs).toEqual([".git", "node_modules"]);
    expect(out.exclusions.noiseGlobs).toContain("package-lock.json");
    expect(out.exclusions.secretGlobs).toContain(".env");
    // allowedNamedFiles surfaces as a sorted array too.
    expect(Array.isArray(out.exclusions.allowedNamedFiles)).toBe(true);
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

// ---- find_literal (#357) -------------------------------------------

describe("tools.findLiteral", () => {
  function runtimeWithMatches(
    matches: Array<{
      projectId: string;
      projectName: string;
      relPath: string;
      chunkKind: string;
      chunkStartLine: number;
      chunkEndLine: number;
      line: number;
      column: number;
      lineText: string;
    }>,
  ): Runtime {
    return stubRuntime({
      state: {
        findLiteralMatches: () => matches,
      } as unknown as Runtime["state"],
    });
  }

  it("requires a non-empty pattern", async () => {
    const runtime = stubRuntime();
    await expect(tools.findLiteral(runtime, {})).rejects.toBeInstanceOf(ToolError);
    await expect(tools.findLiteral(runtime, { pattern: "" })).rejects.toBeInstanceOf(ToolError);
  });

  it("rejects an absurdly long pattern", async () => {
    const runtime = stubRuntime();
    await expect(
      tools.findLiteral(runtime, { pattern: "x".repeat(1100) }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("returns matches with coverageNote + fileCount derived from the hits", async () => {
    const runtime = runtimeWithMatches([
      {
        projectId: "proj-a",
        projectName: "alpha",
        relPath: "docs/a.md",
        chunkKind: "section",
        chunkStartLine: 100,
        chunkEndLine: 110,
        line: 102,
        column: 11,
        lineText: "see [foo](agents/foo.md) for details",
      },
      {
        projectId: "proj-a",
        projectName: "alpha",
        relPath: "docs/a.md",
        chunkKind: "section",
        chunkStartLine: 100,
        chunkEndLine: 110,
        line: 105,
        column: 1,
        lineText: "agents/foo.md (again)",
      },
      {
        projectId: "proj-a",
        projectName: "alpha",
        relPath: "code/score.py",
        chunkKind: "declaration",
        chunkStartLine: 25,
        chunkEndLine: 30,
        line: 29,
        column: 37,
        lineText: "AGENT_MD = Path(__file__).parent / 'agents/foo.md'",
      },
    ]);
    const out = await tools.findLiteral(runtime, { pattern: "agents/foo.md" });
    expect(out.pattern).toBe("agents/foo.md");
    expect(out.matches).toHaveLength(3);
    // fileCount counts distinct files, not matches — two matches in
    // docs/a.md + one in code/score.py = 2 files.
    expect(out.fileCount).toBe(2);
    expect(out.coverageNote).toMatch(/#360|rg/);
    expect(out.indexHealth).toBeDefined();
  });

  it("rejects a path that's outside every indexed project", async () => {
    const runtime = stubRuntime();
    await expect(
      tools.findLiteral(runtime, { pattern: "x", path: "/nowhere/outside" }),
    ).rejects.toBeInstanceOf(ToolError);
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
