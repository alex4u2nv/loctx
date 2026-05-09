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
    // biome-ignore lint/complexity/useLiteralKeys: better-sqlite3 internal access in test
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name")
      .all();
    const names = tables.map((r) => r.name);
    expect(names).toContain("chunks_fts");
    store.close();
  });

  it("re-opening at v1 idempotently runs schema_v2", async () => {
    const dbPath = join(tmp, "state.db");
    // First open: brings DB to current schema (v2).
    new StateStore(dbPath).close();
    // Reset to v1 to simulate an old DB on disk; reopening must run v2 again.
    {
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(dbPath);
      raw.exec("PRAGMA user_version = 1");
      raw.exec("DROP TABLE chunks_fts");
      raw.close();
    }
    const store = new StateStore(dbPath);
    type Row = { name: string };
    // biome-ignore lint/complexity/useLiteralKeys: better-sqlite3 internal access in test
    const db = (store as unknown as { db: { prepare(sql: string): { all(): Row[] } } })["db"];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").all();
    expect(tables).toHaveLength(1);
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
    // biome-ignore lint/complexity/useLiteralKeys: better-sqlite3 internal access in test
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
    // biome-ignore lint/complexity/useLiteralKeys: better-sqlite3 internal access in test
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
    // biome-ignore lint/complexity/useLiteralKeys: better-sqlite3 internal access in test
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
    // biome-ignore lint/complexity/useLiteralKeys: better-sqlite3 internal access in test
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
    // biome-ignore lint/complexity/useLiteralKeys: better-sqlite3 internal access in test
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
});
