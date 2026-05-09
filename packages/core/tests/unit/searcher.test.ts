import { describe, expect, it } from "vitest";
import type { WorkspaceDiscovery } from "../../src/discovery.js";
import type { EmbeddingProvider } from "../../src/embeddings/index.js";
import { type Project, projectId } from "../../src/models.js";
import { WorkspaceSearcher } from "../../src/retrieval/searcher.js";
import type { VectorMatch, VectorQuery, VectorStore } from "../../src/storage/vectors.js";

function fakeProject(idStr: string, name: string, root: string): Project {
  return Object.freeze({ id: projectId(idStr), name, root });
}

function fakeVectors(matches: ReadonlyArray<VectorMatch>): VectorStore {
  // Only the methods the searcher touches are stubbed.
  return {
    async query(_: VectorQuery): Promise<VectorMatch[]> {
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
    );

    const response = await searcher.search({ query: "foo" });
    const [hit] = response.results;
    expect(hit?.projectId).toBe("p1");
    expect(hit?.projectName).toBe("demo");
    expect(hit?.projectRoot).toBe("/tmp/demo");
    expect(hit?.relPath).toBe("src/a.ts");
    expect(hit?.absPath).toBe("/tmp/demo/src/a.ts");
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

  function searcherWith(matches: VectorMatch[]) {
    return new WorkspaceSearcher(fakeVectors(matches), fakeEmbeddings(), fakeDiscovery([a, b]));
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

  it("post-filters results by relPrefix", async () => {
    const matches = [
      {
        chunkId: "c1",
        score: 0.9,
        document: "match",
        metadata: { ...baseMeta, project_id: "p1", rel_path: "src/auth/login.ts" },
      },
      {
        chunkId: "c2",
        score: 0.85,
        document: "miss",
        metadata: { ...baseMeta, project_id: "p1", rel_path: "src/util/helper.ts" },
      },
    ];
    const r = await searcherWith(matches).search({ query: "x", path: "/tmp/alpha/src/auth" });
    expect(r.results.map((x) => x.relPath)).toEqual(["src/auth/login.ts"]);
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
