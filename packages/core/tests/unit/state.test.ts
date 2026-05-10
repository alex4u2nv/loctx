import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EmbeddingIdentity,
  type FileId,
  type Project,
  projectId,
  fileId as toFileId,
} from "../../src/models.js";
import type { FileState } from "../../src/storage/index.js";
import {
  type ChunkInsert,
  CollectionIdentityMismatch,
  StateStore,
} from "../../src/storage/state.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
beforeEach(() => {
  tmp = mkTmpDir();
});
afterEach(() => {
  rmTmpDir(tmp);
});

function makeProject(): Project {
  return Object.freeze({ id: projectId("proj01"), name: "repo", root: join(tmp, "repo") });
}

function fileState(p: Project, sha = "deadbeef"): FileState {
  return {
    fileId: toFileId(`file-src/a.py-${sha}`) as FileId,
    projectId: p.id,
    relPath: "src/a.py",
    size: 42,
    mtime: 1.0,
    contentSha: sha,
    indexedAt: "2024-01-01T00:00:00.000Z",
    embeddingIdentity: "fake|hash|d=16|n=1",
    error: null,
  };
}

describe("StateStore", () => {
  it("round-trips a project + file across reopens", () => {
    const dbPath = join(tmp, "state.db");
    const project = makeProject();
    {
      const store = new StateStore(dbPath);
      store.upsertProject(project);
      store.upsertFile(fileState(project));
      store.close();
    }
    const store = new StateStore(dbPath);
    expect(store.getProject(project.id)).toEqual(project);
    expect(store.listFiles(project.id).length).toBe(1);
    store.close();
  });

  it("upsertFile updates existing row", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const initial = fileState(project, "aaaa");
    store.upsertFile(initial);
    store.upsertFile({ ...initial, contentSha: "bbbb", size: 100 });
    const rows = store.listFiles(project.id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.size).toBe(100);
    expect(rows[0]?.contentSha).toBe("bbbb");
    store.close();
  });

  it("registerCollection is idempotent", () => {
    const id: EmbeddingIdentity = {
      provider: "fake",
      model: "m",
      dimension: 16,
      normalize: true,
    };
    const store = new StateStore(join(tmp, "state.db"));
    store.registerCollection("loctx_x", id);
    store.registerCollection("loctx_x", id);
    expect(store.getCollectionIdentity("loctx_x")).not.toBeNull();
    store.close();
  });

  it("registerCollection rejects mismatch", () => {
    const a: EmbeddingIdentity = {
      provider: "fake",
      model: "m",
      dimension: 16,
      normalize: true,
    };
    const b: EmbeddingIdentity = { ...a, dimension: 32 };
    const store = new StateStore(join(tmp, "state.db"));
    store.registerCollection("loctx_x", a);
    expect(() => store.registerCollection("loctx_x", b)).toThrow(CollectionIdentityMismatch);
    store.close();
  });

  it("creates the chunks_fts FTS5 virtual table on a fresh DB", () => {
    const dbPath = join(tmp, "state.db");
    const store = new StateStore(dbPath);
    type Row = { name: string };
    // Reach into the same SQLite file the store opened. Using the public API
    // here would couple this test to whatever read helper we add in #75; what
    // we actually want to verify is the migration ran.
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name")
      .all();
    const names = tables.map((r) => r.name);
    expect(names).toContain("chunks_fts");
    store.close();
  });

  it("creates the symbol_refs table and chunks.metadata_json on a fresh DB (v3)", () => {
    const dbPath = join(tmp, "state.db");
    const store = new StateStore(dbPath);
    type Row = { name: string };
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = tables.map((r) => r.name);
    expect(names).toContain("symbol_refs");

    type Col = { name: string };
    const cols = db.prepare("PRAGMA table_info(chunks)").all() as unknown as Col[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("metadata_json");
    expect(colNames).toContain("symbol_def");
    store.close();
  });

  it("v2 → v3 migration adds the new columns + table without data loss", async () => {
    const dbPath = join(tmp, "state.db");
    new StateStore(dbPath).close();
    {
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(dbPath);
      // Walk back to v2: drop the v3 additions then reset user_version.
      raw.exec("DROP TABLE IF EXISTS symbol_refs");
      // Can't drop columns in older SQLite without table recreate; use
      // a fresh table instead to simulate a v2 snapshot.
      raw.exec("DROP TABLE chunks");
      raw.exec(
        "CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, kind TEXT NOT NULL, symbols TEXT)",
      );
      raw.exec("CREATE INDEX idx_chunks_file ON chunks(file_id)");
      raw.exec("PRAGMA user_version = 2");
      raw.close();
    }
    const store = new StateStore(dbPath);
    type Row = { name: string };
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_refs'")
      .all();
    expect(tables).toHaveLength(1);

    type Col = { name: string };
    const cols = db.prepare("PRAGMA table_info(chunks)").all() as unknown as Col[];
    expect(cols.map((c) => c.name)).toContain("metadata_json");
    store.close();
  });

  it("re-opening at v1 idempotently runs schema_v2 + schema_v3", async () => {
    const dbPath = join(tmp, "state.db");
    // First open: brings DB to current schema.
    new StateStore(dbPath).close();
    // Walk back to v1 by dropping every v2/v3 addition + recreating
    // chunks without the v3 columns. Reopening must replay both
    // migrations cleanly.
    {
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(dbPath);
      raw.exec("DROP TABLE IF EXISTS chunks_fts");
      raw.exec("DROP TABLE IF EXISTS symbol_refs");
      raw.exec("DROP TABLE chunks");
      raw.exec(
        "CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, kind TEXT NOT NULL, symbols TEXT)",
      );
      raw.exec("CREATE INDEX idx_chunks_file ON chunks(file_id)");
      raw.exec("PRAGMA user_version = 1");
      raw.close();
    }
    const store = new StateStore(dbPath);
    type Row = { name: string };
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").all();
    expect(fts).toHaveLength(1);
    const refs = db.prepare("SELECT name FROM sqlite_master WHERE name='symbol_refs'").all();
    expect(refs).toHaveLength(1);
    store.close();
  });

  it("deleteFile removes the row", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    store.upsertFile(fileState(project));
    store.deleteFile(project.id, "src/a.py");
    expect(store.listFiles(project.id)).toEqual([]);
    store.close();
  });

  it("replaceChunks writes both chunks and chunks_fts in one transaction", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fs = fileState(project);
    store.upsertFile(fs);

    const inserts: ChunkInsert[] = [
      {
        chunkId: "c1",
        fileId: fs.fileId,
        projectId: project.id,
        relPath: "src/a.py",
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["hello"],
        document: "def hello():\n    return 'world'\n",
      },
      {
        chunkId: "c2",
        fileId: fs.fileId,
        projectId: project.id,
        relPath: "src/a.py",
        startLine: 7,
        endLine: 10,
        kind: "class",
        symbols: ["Greeter"],
        document: "class Greeter:\n    pass\n",
      },
    ];
    store.replaceChunks(fs.fileId, inserts);

    expect(store.listChunks(fs.fileId)).toHaveLength(2);

    // Reach into the same DB to confirm chunks_fts populated.
    type Row = { chunk_id: string; document: string; symbols: string };
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const ftsRows = db
      .prepare("SELECT chunk_id, document, symbols FROM chunks_fts ORDER BY chunk_id")
      .all();
    expect(ftsRows.map((r) => r.chunk_id)).toEqual(["c1", "c2"]);
    expect(ftsRows[0]?.document).toContain("hello");
    expect(ftsRows[0]?.symbols).toBe("hello");
    expect(ftsRows[1]?.symbols).toBe("Greeter");

    store.close();
  });

  it("replaceChunks deletes prior FTS rows on re-index", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fs = fileState(project);
    store.upsertFile(fs);

    const v1: ChunkInsert = {
      chunkId: "c1",
      fileId: fs.fileId,
      projectId: project.id,
      relPath: "src/a.py",
      startLine: 1,
      endLine: 3,
      kind: "function",
      symbols: ["old"],
      document: "old body",
    };
    store.replaceChunks(fs.fileId, [v1]);

    const v2: ChunkInsert = { ...v1, chunkId: "c2", symbols: ["new"], document: "new body" };
    store.replaceChunks(fs.fileId, [v2]);

    type Row = { chunk_id: string };
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const ftsRows = db
      .prepare(`SELECT chunk_id FROM chunks_fts WHERE file_id = '${fs.fileId}'`)
      .all();
    expect(ftsRows.map((r) => r.chunk_id)).toEqual(["c2"]);

    store.close();
  });

  it("deleteFile cascades to chunks and chunks_fts", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fs = fileState(project);
    store.upsertFile(fs);

    const insert: ChunkInsert = {
      chunkId: "c1",
      fileId: fs.fileId,
      projectId: project.id,
      relPath: "src/a.py",
      startLine: 1,
      endLine: 3,
      kind: "function",
      symbols: ["foo"],
      document: "def foo(): pass",
    };
    store.replaceChunks(fs.fileId, [insert]);
    expect(store.listChunks(fs.fileId)).toHaveLength(1);

    store.deleteFile(project.id, "src/a.py");

    expect(store.listChunks(fs.fileId)).toEqual([]);
    type Row = { count: number };
    const db = (store as unknown as { db: { prepare(sql: string): { get(): Row } } })["db"];
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM chunks_fts WHERE file_id = '${fs.fileId}'`)
      .get();
    expect(row.count).toBe(0);

    store.close();
  });

  it("deleteProject cascades to chunks_fts, chunks, files, projects", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fs = fileState(project);
    store.upsertFile(fs);

    store.replaceChunks(fs.fileId, [
      {
        chunkId: "p1c1",
        fileId: fs.fileId,
        projectId: project.id,
        relPath: "src/a.py",
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["foo"],
        document: "def foo(): pass",
      },
    ]);

    type CountRow = { count: number };
    const db = (
      store as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): CountRow } } }
    )["db"];
    const count = (table: string): number =>
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? OR file_id IN (SELECT file_id FROM files WHERE project_id = ?)`,
        )
        .get(project.id, project.id).count;

    // Sanity: chunks present.
    expect(store.listChunks(fs.fileId)).toHaveLength(1);

    store.deleteProject(project.id);

    expect(store.getProject(project.id)).toBeNull();
    expect(store.listFiles(project.id)).toEqual([]);
    expect(store.listChunks(fs.fileId)).toEqual([]);
    // chunks_fts: filter by project_id directly since file row is gone.
    const ftsCount = db
      .prepare("SELECT COUNT(*) AS count FROM chunks_fts WHERE project_id = ?")
      .get(project.id);
    expect(ftsCount.count).toBe(0);
    // Suppress the unused-helper warning when COUNT runs above doesn't trip
    // — the JOIN-style helper above is a sanity convenience for diagnostics.
    void count;

    store.close();
  });

  it("FTS5 BM25 finds chunks by document content", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fs = fileState(project);
    store.upsertFile(fs);

    store.replaceChunks(fs.fileId, [
      {
        chunkId: "auth",
        fileId: fs.fileId,
        projectId: project.id,
        relPath: "src/auth.ts",
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["authenticate"],
        document: "verify the user authentication token and return the session.",
      },
      {
        chunkId: "log",
        fileId: fs.fileId,
        projectId: project.id,
        relPath: "src/log.ts",
        startLine: 1,
        endLine: 3,
        kind: "function",
        symbols: ["logger"],
        document: "create a logger that writes to stdout.",
      },
    ]);

    type Row = { chunk_id: string; rank: number };
    const db = (
      store as unknown as { db: { prepare(sql: string): { all(...args: unknown[]): Row[] } } }
    )["db"];
    const hits = db
      .prepare(
        "SELECT chunk_id, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 5",
      )
      .all("authentication");
    expect(hits[0]?.chunk_id).toBe("auth");

    store.close();
  });

  it("findSymbol returns def + refs split by kind, sorted (#96)", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    // Two separate files so the JOIN to `files` produces distinct relPaths.
    const defFile: FileState = {
      ...fileState(project, "aaa"),
      fileId: toFileId("file-auth"),
      relPath: "src/auth.ts",
    };
    const callerFile: FileState = {
      ...fileState(project, "bbb"),
      fileId: toFileId("file-login"),
      relPath: "src/login.ts",
    };
    store.upsertFile(defFile);
    store.upsertFile(callerFile);

    store.replaceChunks(defFile.fileId, [
      {
        chunkId: "def_chunk",
        fileId: defFile.fileId,
        projectId: project.id,
        relPath: defFile.relPath,
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["authenticateUser"],
        document: "function body",
        symbolRefs: [
          { symbol: "authenticateUser", kind: "def", line: 1 },
          { symbol: "verifyJwt", kind: "call", line: 3 },
        ],
      },
    ]);
    store.replaceChunks(callerFile.fileId, [
      {
        chunkId: "caller_chunk",
        fileId: callerFile.fileId,
        projectId: project.id,
        relPath: callerFile.relPath,
        startLine: 10,
        endLine: 14,
        kind: "function",
        symbols: ["login"],
        document: "calls authenticateUser",
        symbolRefs: [
          { symbol: "authenticateUser", kind: "call", line: 12 },
          { symbol: "authenticateUser", kind: "call", line: 13 },
        ],
      },
    ]);

    const result = store.findSymbol(project.id, "authenticateUser");
    expect(result.defs).toHaveLength(1);
    expect(result.defs[0]?.relPath).toBe("src/auth.ts");
    expect(result.defs[0]?.line).toBe(1);
    expect(result.refs).toHaveLength(2);
    expect(result.refs.every((r) => r.kind === "call")).toBe(true);
    // Sorted by file/line — login.ts:12 before login.ts:13.
    expect(result.refs[0]?.line).toBe(12);
    expect(result.refs[1]?.line).toBe(13);
    // Each hit carries the surrounding chunk range for jump UX.
    expect(result.refs[0]?.chunkStartLine).toBe(10);
    expect(result.refs[0]?.chunkEndLine).toBe(14);

    store.close();
  });

  it("findSymbol scopes by project — different project's refs are excluded", () => {
    const projA = makeProject();
    const projB = { ...makeProject(), id: projectId("project-beta"), name: "beta" };
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(projA);
    store.upsertProject(projB);
    const fa: FileState = { ...fileState(projA), relPath: "src/a.ts" };
    const fb: FileState = {
      ...fileState(projB),
      fileId: toFileId("file-beta-1"),
      relPath: "src/b.ts",
    };
    store.upsertFile(fa);
    store.upsertFile(fb);

    store.replaceChunks(fa.fileId, [
      {
        chunkId: "a1",
        fileId: fa.fileId,
        projectId: projA.id,
        relPath: "src/a.ts",
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["foo"],
        document: "x",
        symbolRefs: [{ symbol: "foo", kind: "def", line: 1 }],
      },
    ]);
    store.replaceChunks(fb.fileId, [
      {
        chunkId: "b1",
        fileId: fb.fileId,
        projectId: projB.id,
        relPath: "src/b.ts",
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["foo"],
        document: "y",
        symbolRefs: [{ symbol: "foo", kind: "def", line: 1 }],
      },
    ]);

    const a = store.findSymbol(projA.id, "foo");
    expect(a.defs.map((d) => d.relPath)).toEqual(["src/a.ts"]);
    const b = store.findSymbol(projB.id, "foo");
    expect(b.defs.map((d) => d.relPath)).toEqual(["src/b.ts"]);
  });

  it("findSymbol returns empty when symbol is unknown", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const result = store.findSymbol(project.id, "nonexistent");
    expect(result.defs).toEqual([]);
    expect(result.refs).toEqual([]);
    store.close();
  });

  it("replaceChunks deletes prior symbol_refs on re-index", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fs = fileState(project);
    store.upsertFile(fs);

    store.replaceChunks(fs.fileId, [
      {
        chunkId: "v1",
        fileId: fs.fileId,
        projectId: project.id,
        relPath: "src/a.ts",
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["foo"],
        document: "x",
        symbolRefs: [
          { symbol: "foo", kind: "def", line: 1 },
          { symbol: "stale", kind: "call", line: 2 },
        ],
      },
    ]);
    store.replaceChunks(fs.fileId, [
      {
        chunkId: "v2",
        fileId: fs.fileId,
        projectId: project.id,
        relPath: "src/a.ts",
        startLine: 1,
        endLine: 5,
        kind: "function",
        symbols: ["foo"],
        document: "y",
        symbolRefs: [{ symbol: "foo", kind: "def", line: 1 }],
      },
    ]);

    const stale = store.findSymbol(project.id, "stale");
    expect(stale.refs).toEqual([]);
    const foo = store.findSymbol(project.id, "foo");
    expect(foo.defs).toHaveLength(1);
  });

  it("upsertFileEnrichment + getFileEnrichment round-trip (#62)", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fs = fileState(project);
    store.upsertFile(fs);

    store.upsertFileEnrichment({
      fileId: fs.fileId,
      analyzer: "lizard",
      analyzerVersion: 1,
      contentSha: fs.contentSha,
      status: "complete",
      payloadJson: JSON.stringify({ functions: [{ name: "foo", ccn: 3 }] }),
      enqueuedAt: "2026-05-10T00:00:00.000Z",
      completedAt: "2026-05-10T00:00:01.000Z",
    });

    const got = store.getFileEnrichment(fs.fileId, "lizard");
    expect(got?.status).toBe("complete");
    expect(got?.analyzerVersion).toBe(1);
    expect(JSON.parse(got?.payloadJson ?? "{}").functions[0].name).toBe("foo");

    // Upsert again with new payload — should overwrite.
    store.upsertFileEnrichment({
      fileId: fs.fileId,
      analyzer: "lizard",
      analyzerVersion: 2,
      contentSha: "newsha",
      status: "failed",
      error: "lizard returned non-zero",
    });
    const updated = store.getFileEnrichment(fs.fileId, "lizard");
    expect(updated?.status).toBe("failed");
    expect(updated?.analyzerVersion).toBe(2);
    expect(updated?.error).toBe("lizard returned non-zero");
    expect(updated?.payloadJson).toBeUndefined();
  });

  it("findDuplicateGroups groups by hash across files (#65)", () => {
    const project = makeProject();
    const store = new StateStore(join(tmp, "state.db"));
    store.upsertProject(project);
    const fa: FileState = { ...fileState(project), fileId: toFileId("f-a"), relPath: "a.ts" };
    const fb: FileState = { ...fileState(project), fileId: toFileId("f-b"), relPath: "b.ts" };
    const fc: FileState = { ...fileState(project), fileId: toFileId("f-c"), relPath: "c.ts" };
    store.upsertFile(fa);
    store.upsertFile(fb);
    store.upsertFile(fc);

    const sharedHash = "abc123";
    const uniqueHash = "unique";

    store.upsertFileEnrichment({
      fileId: fa.fileId,
      analyzer: "duplicates",
      analyzerVersion: 1,
      contentSha: fa.contentSha,
      status: "complete",
      payloadJson: JSON.stringify({
        windows: [{ hash: sharedHash, startLine: 5, endLine: 25 }],
      }),
    });
    store.upsertFileEnrichment({
      fileId: fb.fileId,
      analyzer: "duplicates",
      analyzerVersion: 1,
      contentSha: fb.contentSha,
      status: "complete",
      payloadJson: JSON.stringify({
        windows: [{ hash: sharedHash, startLine: 10, endLine: 30 }],
      }),
    });
    store.upsertFileEnrichment({
      fileId: fc.fileId,
      analyzer: "duplicates",
      analyzerVersion: 1,
      contentSha: fc.contentSha,
      status: "complete",
      payloadJson: JSON.stringify({
        windows: [{ hash: uniqueHash, startLine: 1, endLine: 20 }],
      }),
    });

    const groups = store.findDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hash).toBe(sharedHash);
    expect(groups[0]?.members.length).toBe(2);
    const fileIds = groups[0]?.members.map((m) => m.fileId).sort();
    expect(fileIds).toEqual(["f-a", "f-b"]);
  });
});
