import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDiscovery } from "../../src/discovery.js";
import type { EmbeddingProvider } from "../../src/embeddings/index.js";
import { type AnalyzerMetadata, type Project, projectId } from "../../src/models.js";
import { WorkspaceSearcher } from "../../src/retrieval/searcher.js";
import type { LexicalMatch, LexicalQuery, StateStore } from "../../src/storage/state.js";
import type { VectorMatch, VectorQuery, VectorStore } from "../../src/storage/vectors.js";

function fakeProject(idStr: string, name: string, root: string): Project {
  return Object.freeze({ id: projectId(idStr), name, root });
}

function fakeVectors(
  matches: ReadonlyArray<VectorMatch>,
  capture?: { lastQuery: VectorQuery | null },
): VectorStore {
  return {
    async query(q: VectorQuery): Promise<VectorMatch[]> {
      if (capture !== undefined) capture.lastQuery = q;
      return [...matches];
    },
  } as unknown as VectorStore;
}

function fakeEmbeddings(): EmbeddingProvider {
  return {
    identity: { provider: "fake", model: "test", dimension: 4, normalize: true },
    async embedQuery() {
      return [0, 0, 0, 0];
    },
    async embedDocuments(docs: ReadonlyArray<string>) {
      return docs.map(() => [0, 0, 0, 0]);
    },
  } as unknown as EmbeddingProvider;
}

function fakeDiscovery(projects: Project[]): WorkspaceDiscovery {
  return {
    discoverProjects: () => projects,
    // Mimic the real resolveProject: walk upward and return the *deepest*
    // (longest-root) project containing cwd. Real impl walks dirname chain
    // until it finds a marker; the depth ordering matches the behavior the
    // tests for #276 need to exercise.
    resolveProject: (cwd: string) => {
      const containing = projects.filter((p) => cwd === p.root || cwd.startsWith(`${p.root}/`));
      if (containing.length === 0) return null;
      return containing.reduce((a, b) => (b.root.length > a.root.length ? b : a));
    },
  } as unknown as WorkspaceDiscovery;
}

interface StateCapture {
  lastQuery: LexicalQuery | null;
}

interface FakeIndexedProject {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly active?: boolean;
}

function fakeState(
  matches: ReadonlyArray<LexicalMatch> = [],
  capture?: StateCapture,
  indexed: ReadonlyArray<FakeIndexedProject> = [],
): StateStore {
  return {
    searchLexical: (q: LexicalQuery): LexicalMatch[] => {
      if (capture !== undefined) capture.lastQuery = q;
      return [...matches];
    },
    // Searcher batch-fetches analyzer metadata after fusion (#60). The
    // unit suite isn't testing analyzer ranking; return empty so the
    // existing assertions stay focused on RRF + scope behavior.
    getAnalyzersByChunkIds: () => new Map(),
    // Authority ranking (#427) queries the cross-link graph; no links in
    // these unit fixtures, so every file has 0 inbound references. The
    // searcher batches these via inboundCounts (#446).
    inboundCount: () => 0,
    inboundCounts: () => new Map<string, number>(),
    // Enrichment surfacing (lizard, etc.) reads file_enrichments via
    // getFile + getFileEnrichment. Stub them to nothing so the suite
    // doesn't have to opt in to those tables for every test.
    getFile: () => null,
    getFileEnrichment: () => null,
    // Scope resolver (#276) consults listProjects to prefer indexed
    // ancestors over discovery-detected markers.
    listProjects: () =>
      indexed.map((p) => ({
        id: projectId(p.id),
        name: p.name,
        root: p.root,
        lastIndexedAt: "2026-05-17T00:00:00.000Z",
        lastReconciledAt: null,
        active: p.active ?? true,
      })),
  } as unknown as StateStore;
}

const baseMeta = {
  rel_path: "src/a.ts",
  start_line: 10,
  end_line: 20,
  language: "ts",
  kind: "function",
  symbols: "foo",
};

describe("WorkspaceSearcher result enrichment", () => {
  it("attaches projectName, projectRoot and absPath when the project is on disk", async () => {
    const proj = fakeProject("p1", "demo", "/tmp/demo");
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "c1",
          score: 0.9,
          document: "function foo() {}",
          metadata: { ...baseMeta, project_id: "p1" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      fakeState(),
    );

    const response = await searcher.search({ query: "foo" });
    const [hit] = response.results;
    expect(hit?.projectId).toBe("p1");
    expect(hit?.projectName).toBe("demo");
    expect(hit?.projectRoot).toBe("/tmp/demo");
    expect(hit?.relPath).toBe("src/a.ts");
    expect(hit?.absPath).toBe("/tmp/demo/src/a.ts");
    // Vector-only hit (no lexical match) → sources is just ["vector"].
    expect(hit?.sources).toEqual(["vector"]);
  });

  it("returns null projectRoot/absPath for chunks whose project is no longer registered", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "c2",
          score: 0.5,
          document: "stale",
          metadata: { ...baseMeta, project_id: "ghost" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([]),
      fakeState(),
    );

    const response = await searcher.search({ query: "foo" });
    const [hit] = response.results;
    expect(hit?.projectId).toBe("ghost");
    expect(hit?.projectName).toBe("");
    expect(hit?.projectRoot).toBeNull();
    expect(hit?.absPath).toBeNull();
    expect(hit?.relPath).toBe("src/a.ts");
  });

  it("works for `all` scope across multiple projects", async () => {
    const a = fakeProject("p1", "alpha", "/tmp/alpha");
    const b = fakeProject("p2", "beta", "/tmp/beta");
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        { chunkId: "c1", score: 0.9, document: "a", metadata: { ...baseMeta, project_id: "p1" } },
        {
          chunkId: "c2",
          score: 0.8,
          document: "b",
          metadata: { ...baseMeta, project_id: "p2", rel_path: "lib/b.ts" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([a, b]),
      fakeState(),
    );

    const response = await searcher.search({ query: "x" });
    expect(response.results.map((r) => r.absPath)).toEqual([
      "/tmp/alpha/src/a.ts",
      "/tmp/beta/lib/b.ts",
    ]);
  });
});

describe("authority ranking (#427)", () => {
  it("lifts a heavily-referenced canonical doc above a higher-scored derivative", async () => {
    const proj = fakeProject("p1", "docs", "/tmp/docs");
    const state = {
      searchLexical: () => [],
      getAnalyzersByChunkIds: () => new Map(),
      // governance.md is linked by 10 other docs; the slide deck by none.
      // The searcher batches these via inboundCounts (#446).
      inboundCounts: (paths: ReadonlyArray<string>) =>
        new Map(paths.map((p) => [p, p.endsWith("governance.md") ? 10 : 0])),
      getFile: () => null,
      getFileEnrichment: () => null,
      listProjects: () => [
        {
          id: projectId("p1"),
          name: "docs",
          root: "/tmp/docs",
          lastIndexedAt: "2026-01-01T00:00:00.000Z",
          lastReconciledAt: null,
          active: true,
        },
      ],
    } as unknown as StateStore;
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        // The derivative slide ranks higher by raw similarity…
        {
          chunkId: "deck",
          score: 0.9,
          document: "approval gate slide",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "presentations/deck.md" },
        },
        // …the canonical process doc lower.
        {
          chunkId: "gov",
          score: 0.5,
          document: "approval gate process",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "governance.md" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      state,
    );

    const response = await searcher.search({ query: "approval gate" });
    // Authority boost (10 inbound) + derivative penalty flips the order.
    expect(response.results[0]?.relPath).toBe("governance.md");
    expect(response.results[0]?.referencedBy).toBe(10);
    expect(response.results[0]?.matchReasons).toContain("authoritative");
    const deck = response.results.find((r) => r.relPath === "presentations/deck.md");
    expect(deck?.matchReasons).toContain("derivative");
    expect(deck?.referencedBy).toBe(0);
  });
});

describe("WorkspaceSearcher path-based scope", () => {
  const a = fakeProject("p1", "alpha", "/tmp/alpha");
  const b = fakeProject("p2", "beta", "/tmp/beta");

  function searcherWith(matches: VectorMatch[], state: StateStore = fakeState()) {
    return new WorkspaceSearcher(
      fakeVectors(matches),
      fakeEmbeddings(),
      fakeDiscovery([a, b]),
      state,
    );
  }

  it("resolves a project root path to project scope", async () => {
    const r = await searcherWith([]).search({ query: "x", path: "/tmp/alpha" });
    expect(r.resolvedScope.mode).toBe("project");
    expect(r.resolvedScope.project?.id).toBe("p1");
    expect(r.resolvedScope.relPrefix).toBeNull();
    expect(r.warnings).toHaveLength(0);
  });

  it("resolves a path inside a project to subtree scope with the leftover as a relPrefix", async () => {
    const r = await searcherWith([]).search({ query: "x", path: "/tmp/alpha/src/auth" });
    expect(r.resolvedScope.mode).toBe("subtree");
    expect(r.resolvedScope.project?.id).toBe("p1");
    expect(r.resolvedScope.relPrefix).toBe("src/auth/");
  });

  it("pushes path-prefix into the vector WHERE clause", async () => {
    const vectorCapture: { lastQuery: VectorQuery | null } = { lastQuery: null };
    const searcher = new WorkspaceSearcher(
      fakeVectors([], vectorCapture),
      fakeEmbeddings(),
      fakeDiscovery([a, b]),
      fakeState(),
    );
    await searcher.search({ query: "x", path: "/tmp/alpha/src/auth" });
    expect(vectorCapture.lastQuery?.where).toContain("project_id = 'p1'");
    expect(vectorCapture.lastQuery?.where).toContain("rel_path LIKE 'src/auth/%'");
  });

  it("pushes path-prefix into the lexical query", async () => {
    const lexCapture: StateCapture = { lastQuery: null };
    const searcher = new WorkspaceSearcher(
      fakeVectors([]),
      fakeEmbeddings(),
      fakeDiscovery([a, b]),
      fakeState([], lexCapture),
    );
    await searcher.search({ query: "auth", path: "/tmp/alpha/src/auth" });
    expect(lexCapture.lastQuery?.projectId).toBe("p1");
    expect(lexCapture.lastQuery?.relPathPrefix).toBe("src/auth/");
    // Searcher converts natural-language input into an FTS5 OR expression
    // with each token quoted; single-token query becomes `"auth"`.
    expect(lexCapture.lastQuery?.query).toBe('"auth"');
  });

  it("warns and falls back to all when path is outside every indexed project", async () => {
    const r = await searcherWith([]).search({ query: "x", path: "/etc" });
    expect(r.resolvedScope.mode).toBe("all");
    expect(r.resolvedScope.project).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/not inside any indexed project/);
  });

  it("omitting path searches all", async () => {
    const r = await searcherWith([]).search({ query: "x" });
    expect(r.resolvedScope.mode).toBe("all");
    expect(r.warnings).toHaveLength(0);
  });
});

describe("WorkspaceSearcher scope prefers indexed ancestor (#276)", () => {
  // Monorepo root is indexed; the inner package has its own marker but is
  // NOT in state. Discovery surfaces both. Scope resolution should pick the
  // indexed parent and rewrite relPrefix from the parent's root.
  const monorepoRoot = "/tmp/loctx";
  const innerPkg = "/tmp/loctx/apps/cli";
  const outer = fakeProject("outer", "loctx", monorepoRoot);
  const inner = fakeProject("inner", "cli", innerPkg);

  it("falls back to indexed parent when the inner marker isn't indexed", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([]),
      fakeEmbeddings(),
      fakeDiscovery([outer, inner]),
      fakeState([], undefined, [{ id: "outer", name: "loctx", root: monorepoRoot }]),
    );
    const r = await searcher.search({ query: "x", path: "/tmp/loctx/apps/cli/src" });
    expect(r.resolvedScope.mode).toBe("subtree");
    expect(r.resolvedScope.project?.id).toBe("outer");
    expect(r.resolvedScope.relPrefix).toBe("apps/cli/src/");
    expect(r.warnings.some((w) => /unindexed inner project/.test(w))).toBe(true);
  });

  it("uses the inner project when it IS indexed (no warning)", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([]),
      fakeEmbeddings(),
      fakeDiscovery([outer, inner]),
      fakeState([], undefined, [
        { id: "outer", name: "loctx", root: monorepoRoot },
        { id: "inner", name: "cli", root: innerPkg },
      ]),
    );
    const r = await searcher.search({ query: "x", path: "/tmp/loctx/apps/cli/src" });
    expect(r.resolvedScope.mode).toBe("subtree");
    expect(r.resolvedScope.project?.id).toBe("inner");
    expect(r.resolvedScope.relPrefix).toBe("src/");
    expect(r.warnings).toHaveLength(0);
  });

  it("skips inactive indexed-ancestor candidates", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([]),
      fakeEmbeddings(),
      fakeDiscovery([outer, inner]),
      fakeState([], undefined, [{ id: "outer", name: "loctx", root: monorepoRoot, active: false }]),
    );
    const r = await searcher.search({ query: "x", path: "/tmp/loctx/apps/cli/src" });
    // No indexed ancestor available → falls back to the marker project (inner),
    // preserving prior behavior for projects the user hasn't activated.
    expect(r.resolvedScope.project?.id).toBe("inner");
    expect(r.warnings).toHaveLength(0);
  });
});

describe("WorkspaceSearcher hybrid retrieval (RRF)", () => {
  const proj = fakeProject("p1", "demo", "/tmp/demo");

  function lex(chunkId: string, relPath: string, document: string, rank = -1): LexicalMatch {
    return {
      chunkId,
      fileId: "f1" as never,
      projectId: proj.id,
      relPath,
      startLine: 1,
      endLine: 5,
      kind: "function",
      symbols: Object.freeze(["foo"]),
      document,
      rank,
    };
  }

  it("fuses vector and lexical hits with RRF and reports both sources", async () => {
    const vectorMatches: VectorMatch[] = [
      {
        chunkId: "c1",
        score: 0.95,
        document: "vector hit",
        metadata: { ...baseMeta, project_id: "p1", rel_path: "a.ts" },
      },
      {
        chunkId: "c2",
        score: 0.5,
        document: "vector only",
        metadata: { ...baseMeta, project_id: "p1", rel_path: "b.ts" },
      },
    ];
    const lexicalMatches = [
      lex("c1", "a.ts", "lexical match for c1", -1.5),
      lex("c3", "c.ts", "lexical only", -1.0),
    ];
    const searcher = new WorkspaceSearcher(
      fakeVectors(vectorMatches),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      fakeState(lexicalMatches),
    );

    const r = await searcher.search({ query: "foo" });

    // c1 gets RRF contributions from both branches at rank 1 and 1 → highest.
    // c2 only from vector at rank 2. c3 only from lexical at rank 2.
    expect(r.results[0]?.chunkId).toBeUndefined(); // SearchResult doesn't expose chunkId
    expect(r.results[0]?.relPath).toBe("a.ts");
    expect(r.results[0]?.sources).toEqual(["lexical", "vector"]);

    const aux = r.results.slice(1).map((x) => x.relPath);
    expect(aux).toContain("b.ts");
    expect(aux).toContain("c.ts");
  });

  it("returns no results when both branches are empty", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      fakeState([]),
    );
    const r = await searcher.search({ query: "nope" });
    expect(r.results).toHaveLength(0);
  });

  it("vector-only mode skips the lexical branch entirely", async () => {
    const lexCapture: StateCapture = { lastQuery: null };
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "c1",
          score: 0.9,
          document: "x",
          metadata: { ...baseMeta, project_id: "p1" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      fakeState([], lexCapture),
      { mode: "vector", rrfK: 60 },
    );
    const r = await searcher.search({ query: "foo" });
    expect(lexCapture.lastQuery).toBeNull();
    expect(r.results[0]?.sources).toEqual(["vector"]);
  });

  it("lexical-only mode skips embedding + vector query", async () => {
    const vectorCapture: { lastQuery: VectorQuery | null } = { lastQuery: null };
    const searcher = new WorkspaceSearcher(
      fakeVectors([], vectorCapture),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      fakeState([lex("c1", "a.ts", "lexical hit")]),
      { mode: "lexical", rrfK: 60 },
    );
    const r = await searcher.search({ query: "foo" });
    expect(vectorCapture.lastQuery).toBeNull();
    expect(r.results[0]?.sources).toEqual(["lexical"]);
  });

  it("falls back to vector-only when lexical branch throws", async () => {
    const throwing: StateStore = {
      searchLexical: vi.fn(() => {
        throw new Error("FTS5 syntax error");
      }),
      getAnalyzersByChunkIds: () => new Map(),
      inboundCount: () => 0,
      inboundCounts: () => new Map<string, number>(),
      getFile: () => null,
      getFileEnrichment: () => null,
    } as unknown as StateStore;
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "c1",
          score: 0.9,
          document: "x",
          metadata: { ...baseMeta, project_id: "p1" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      throwing,
    );
    const r = await searcher.search({ query: "with: bad syntax" });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.sources).toEqual(["vector"]);
  });
});

describe("WorkspaceSearcher analyzer-driven match reasons (#60)", () => {
  const proj = fakeProject("p1", "demo", "/tmp/demo");

  function meta(partial: Partial<AnalyzerMetadata>): AnalyzerMetadata {
    return Object.freeze({
      imports: Object.freeze<string[]>([]),
      exports: Object.freeze<string[]>([]),
      calls: Object.freeze<string[]>([]),
      maxNestingDepth: 0,
      maxLoopDepth: 0,
      paramCount: 0,
      hasAsync: false,
      hasRecursionHint: false,
      riskyCalls: Object.freeze<string[]>([]),
      analysisSource: "tree-sitter",
      analysisVersion: 1,
      ...partial,
    });
  }

  function stateWithAnalyzers(
    matches: ReadonlyArray<LexicalMatch>,
    byChunk: Record<string, AnalyzerMetadata>,
  ): StateStore {
    return {
      searchLexical: () => [...matches],
      inboundCounts: () => new Map<string, number>(),
      getAnalyzersByChunkIds: (ids: ReadonlyArray<string>) => {
        const m = new Map<string, AnalyzerMetadata | null>();
        for (const id of ids) m.set(id, byChunk[id] ?? null);
        return m;
      },
      inboundCount: () => 0,
      getFile: () => null,
      getFileEnrichment: () => null,
    } as unknown as StateStore;
  }

  it("fires symbol_match + exported when an exported name appears in the query", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "c1",
          score: 0.8,
          document: "export function authenticateUser() {}",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "auth.ts" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      stateWithAnalyzers([], { c1: meta({ exports: ["authenticateUser"] }) }),
    );
    const r = await searcher.search({ query: "authenticateUser please" });
    expect(r.results[0]?.matchReasons).toEqual(
      expect.arrayContaining(["symbol_match", "exported"]),
    );
  });

  it("fires risky_call_category only when the query mentions the category", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "r1",
          score: 0.5,
          document: "exec(cmd)",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "shell.ts" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      stateWithAnalyzers([], { r1: meta({ riskyCalls: ["exec", "spawn"] }) }),
    );
    const yes = await searcher.search({ query: "where do we exec a shell command" });
    expect(yes.results[0]?.matchReasons).toContain("risky_call_category");
    const no = await searcher.search({ query: "innocuous query" });
    expect(no.results[0]?.matchReasons).not.toContain("risky_call_category");
  });

  it("fires complexity_signal only when the query asks for it AND the chunk qualifies", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "x1",
          score: 0.5,
          document: "deeply nested",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "nested.ts" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      stateWithAnalyzers([], { x1: meta({ maxNestingDepth: 6 }) }),
    );
    const yes = await searcher.search({ query: "deeply nested function" });
    expect(yes.results[0]?.matchReasons).toContain("complexity_signal");
    const no = await searcher.search({ query: "function" });
    expect(no.results[0]?.matchReasons).not.toContain("complexity_signal");
  });

  it("attaches analyzer payload (or null when missing) to every result", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "c1",
          score: 0.5,
          document: "x",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "a.ts" },
        },
        {
          chunkId: "c2",
          score: 0.4,
          document: "y",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "b.ts" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      stateWithAnalyzers([], { c1: meta({ hasAsync: true }) }),
    );
    const r = await searcher.search({ query: "anything" });
    const c1 = r.results.find((x) => x.relPath === "a.ts");
    const c2 = r.results.find((x) => x.relPath === "b.ts");
    expect(c1?.analyzer?.hasAsync).toBe(true);
    expect(c2?.analyzer).toBeNull();
  });
});

describe("WorkspaceSearcher coverage expansion (#72)", () => {
  const proj = fakeProject("p1", "demo", "/tmp/demo");

  function meta(partial: Partial<AnalyzerMetadata>): AnalyzerMetadata {
    return Object.freeze({
      imports: Object.freeze<string[]>([]),
      exports: Object.freeze<string[]>([]),
      calls: Object.freeze<string[]>([]),
      maxNestingDepth: 0,
      maxLoopDepth: 0,
      paramCount: 0,
      hasAsync: false,
      hasRecursionHint: false,
      riskyCalls: Object.freeze<string[]>([]),
      analysisSource: "tree-sitter",
      analysisVersion: 1,
      ...partial,
    });
  }

  function makeState(opts: {
    analyzersByChunk: Record<string, AnalyzerMetadata>;
    findSymbolBy?: (
      id: string,
      sym: string,
    ) => {
      defs: Array<{
        relPath: string;
        chunkStartLine: number;
        chunkEndLine: number;
        chunkId: string;
        kind: string;
        projectId: string;
      }>;
      refs: Array<{
        relPath: string;
        chunkStartLine: number;
        chunkEndLine: number;
        chunkId: string;
        kind: string;
        projectId: string;
      }>;
    };
  }): StateStore {
    return {
      searchLexical: () => [],
      inboundCounts: () => new Map<string, number>(),
      getAnalyzersByChunkIds: (ids: ReadonlyArray<string>) => {
        const m = new Map<string, AnalyzerMetadata | null>();
        for (const id of ids) m.set(id, opts.analyzersByChunk[id] ?? null);
        return m;
      },
      findSymbol: opts.findSymbolBy
        ? (id: string, sym: string) => opts.findSymbolBy?.(id, sym) ?? { defs: [], refs: [] }
        : () => ({ defs: [], refs: [] }),
      inboundCount: () => 0,
      getFile: () => null,
      getFileEnrichment: () => null,
    } as unknown as StateStore;
  }

  it("expands top hits with caller-of: results when coverage=true", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "auth",
          score: 0.9,
          document: "export function authenticate() {}",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "src/auth.ts" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      makeState({
        analyzersByChunk: { auth: meta({ exports: ["authenticate"] }) },
        findSymbolBy: (_pid, sym) => ({
          defs: [],
          refs:
            sym === "authenticate"
              ? [
                  {
                    relPath: "src/login.ts",
                    chunkStartLine: 12,
                    chunkEndLine: 18,
                    chunkId: "login_chunk",
                    kind: "call",
                    projectId: "p1",
                  },
                ]
              : [],
        }),
      }),
    );

    const baseline = await searcher.search({ query: "authenticate" });
    expect(baseline.results.every((r) => r.coverageReason === null)).toBe(true);

    const expanded = await searcher.search({ query: "authenticate", coverage: true });
    const coverageHits = expanded.results.filter((r) => r.coverageReason !== null);
    expect(coverageHits.length).toBe(1);
    expect(coverageHits[0]?.relPath).toBe("src/login.ts");
    expect(coverageHits[0]?.coverageReason).toBe("caller-of:authenticate");
  });

  it("dedupes coverage hits against the original ranked list", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "auth",
          score: 0.9,
          document: "export function authenticate() {}",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "src/auth.ts", start_line: 1 },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      makeState({
        analyzersByChunk: { auth: meta({ exports: ["authenticate"] }) },
        findSymbolBy: () => ({
          defs: [],
          refs: [
            {
              // Same chunk identity as the original result.
              relPath: "src/auth.ts",
              chunkStartLine: 1,
              chunkEndLine: 5,
              chunkId: "auth",
              kind: "call",
              projectId: "p1",
            },
          ],
        }),
      }),
    );

    const r = await searcher.search({ query: "authenticate", coverage: true });
    const coverageHits = r.results.filter((x) => x.coverageReason !== null);
    expect(coverageHits).toEqual([]);
  });

  it("no-ops when the top hit has no exported symbols", async () => {
    const searcher = new WorkspaceSearcher(
      fakeVectors([
        {
          chunkId: "x",
          score: 0.9,
          document: "x",
          metadata: { ...baseMeta, project_id: "p1", rel_path: "src/x.ts" },
        },
      ]),
      fakeEmbeddings(),
      fakeDiscovery([proj]),
      makeState({ analyzersByChunk: { x: meta({}) } }),
    );
    const r = await searcher.search({ query: "x", coverage: true });
    expect(r.results.every((x) => x.coverageReason === null)).toBe(true);
  });
});
