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
import { CollectionIdentityMismatch, StateStore } from "../../src/storage/state.js";
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
});
