import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDiscovery } from "../../src/discovery.js";
import type { EmbeddingProvider } from "../../src/embeddings/index.js";
import { type Project, projectId } from "../../src/models.js";
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
    resolveProject: (cwd: string) =>
      projects.find((p) => cwd === p.root || cwd.startsWith(`${p.root}/`)) ?? null,
  } as unknown as WorkspaceDiscovery;
}

interface StateCapture {
  lastQuery: LexicalQuery | null;
}

function fakeState(matches: ReadonlyArray<LexicalMatch> = [], capture?: StateCapture): StateStore {
  return {
    searchLexical: (q: LexicalQuery): LexicalMatch[] => {
      if (capture !== undefined) capture.lastQuery = q;
      return [...matches];
    },
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
    expect(lexCapture.lastQuery?.query).toBe("auth");
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
