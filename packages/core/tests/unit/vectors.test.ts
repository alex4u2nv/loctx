import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChunkId,
  chunkId,
  type EmbeddingIdentity,
  type FileId,
  fileId,
  type ProjectId,
  projectId,
} from "../../src/models.js";
import { StateStore } from "../../src/storage/state.js";
import {
  createVectorStore,
  type EmbeddedChunk,
  purgeProjectVectors,
} from "../../src/storage/vectors.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

const DIM = 4;

const identity: EmbeddingIdentity = Object.freeze({
  provider: "test",
  model: "tiny",
  dimension: DIM,
  normalize: true,
});

let tmp: string;
let state: StateStore;
beforeEach(() => {
  tmp = mkTmpDir();
  state = new StateStore(join(tmp, "state.sqlite3"));
});
afterEach(() => {
  state.close();
  rmTmpDir(tmp);
});

function unitVector(...components: number[]): ReadonlyArray<number> {
  if (components.length !== DIM) throw new Error("test vector must match DIM");
  let mag = 0;
  for (const c of components) mag += c * c;
  const scale = 1 / Math.sqrt(mag);
  return components.map((c) => c * scale);
}

function chunk(
  id: string,
  vec: ReadonlyArray<number>,
  overrides: Partial<EmbeddedChunk> = {},
): EmbeddedChunk {
  const pid = projectId("p1") as ProjectId;
  return {
    chunkId: chunkId(id) as ChunkId,
    fileId: fileId("f1") as FileId,
    projectId: pid,
    relPath: "src/a.ts",
    embedding: vec,
    document: `doc-${id}`,
    metadata: { language: "ts", kind: "function", start_line: 1, end_line: 10, symbols: "foo" },
    ...overrides,
  };
}

describe("VectorStore (LanceDB)", () => {
  it("round-trips upsert + nearest-neighbour search", async () => {
    const store = createVectorStore(join(tmp, "vectors"), identity, state);
    await store.upsertChunks([
      chunk("c1", unitVector(1, 0, 0, 0)),
      chunk("c2", unitVector(0, 1, 0, 0)),
      chunk("c3", unitVector(0, 0, 1, 0)),
    ]);

    expect(await store.count()).toBe(3);

    const results = await store.query({ embedding: unitVector(0.95, 0.05, 0, 0), k: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]?.chunkId).toBe("c1");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? Number.NEGATIVE_INFINITY);
    expect(results[0]?.document).toBe("doc-c1");
    expect(results[0]?.metadata).toMatchObject({
      project_id: "p1",
      rel_path: "src/a.ts",
      language: "ts",
    });
  });

  it("merge-inserts replace existing rows on the same chunk_id", async () => {
    const store = createVectorStore(join(tmp, "vectors"), identity, state);
    await store.upsertChunks([chunk("c1", unitVector(1, 0, 0, 0))]);
    await store.upsertChunks([
      chunk("c1", unitVector(0, 1, 0, 0), { document: "updated", relPath: "src/b.ts" }),
    ]);

    expect(await store.count()).toBe(1);
    const [hit] = await store.query({ embedding: unitVector(0, 1, 0, 0), k: 1 });
    expect(hit?.document).toBe("updated");
    expect(hit?.metadata).toMatchObject({ rel_path: "src/b.ts" });
  });

  it("delete by file scopes precisely", async () => {
    const store = createVectorStore(join(tmp, "vectors"), identity, state);
    await store.upsertChunks([
      chunk("c1", unitVector(1, 0, 0, 0), { relPath: "a.ts" }),
      chunk("c2", unitVector(0, 1, 0, 0), { relPath: "b.ts" }),
    ]);
    await store.deleteFileChunks(projectId("p1") as ProjectId, "a.ts");

    expect(await store.count()).toBe(1);
    const [hit] = await store.query({ embedding: unitVector(0, 1, 0, 0), k: 1 });
    expect(hit?.metadata).toMatchObject({ rel_path: "b.ts" });
  });

  it("serialises concurrent writes through the per-store mutex (#142)", async () => {
    // Fires 8 overlapping upsert/delete calls. Pre-mutex this would
    // trigger LanceDB's \"Too many concurrent writers\" error on a busy
    // multi-project setup; the mutex turns the race into a queue.
    const store = createVectorStore(join(tmp, "vectors"), identity, state);
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 8; i += 1) {
      ops.push(store.upsertChunks([chunk(`c${i}`, unitVector(1, 0, 0, 0))]));
    }
    ops.push(store.deleteFileChunks(projectId("p1") as ProjectId, "src/a.ts"));
    // No throw → mutex held the line.
    await Promise.all(ops);
  });

  it("purgeProjectVectors deletes a project from every registered collection (#448)", async () => {
    // Two collections in one vector dir — as after an embedding-model
    // switch. The registry-driven purge must reach rows in both without
    // any identity in hand.
    const otherIdentity: EmbeddingIdentity = Object.freeze({
      provider: "test",
      model: "tiny-v2",
      dimension: DIM,
      normalize: true,
    });
    const dir = join(tmp, "vectors");
    const storeA = createVectorStore(dir, identity, state);
    const storeB = createVectorStore(dir, otherIdentity, state);
    await storeA.upsertChunks([
      chunk("a1", unitVector(1, 0, 0, 0)),
      chunk("a2", unitVector(0, 1, 0, 0), {
        projectId: projectId("p2") as ProjectId,
        fileId: fileId("f2") as FileId,
      }),
    ]);
    await storeB.upsertChunks([chunk("b1", unitVector(0, 0, 1, 0))]);

    const touched = await purgeProjectVectors(
      dir,
      state.listCollections(),
      projectId("p1") as ProjectId,
    );

    expect(touched).toBe(2);
    // Fresh handles for the reads: the purge writes through its own
    // LanceDB connection, and the original stores' cached table handles
    // can serve the pre-delete version. The real caller (CLI purge
    // fallback) is a fresh process with no other handles open.
    const freshA = createVectorStore(dir, identity, state);
    const freshB = createVectorStore(dir, otherIdentity, state);
    // p1 rows gone from both collections; p2 untouched.
    expect(await freshA.count()).toBe(1);
    expect(await freshB.count()).toBe(0);
    const [survivor] = await freshA.query({ embedding: unitVector(0, 1, 0, 0), k: 1 });
    expect(survivor?.metadata).toMatchObject({ project_id: "p2" });
  });

  it("purgeProjectVectors is a no-op on a missing vector dir or unknown collections", async () => {
    expect(
      await purgeProjectVectors(join(tmp, "does-not-exist"), ["loctx_nope"], projectId("p1")),
    ).toBe(0);
    expect(await purgeProjectVectors(join(tmp, "also-missing"), [], projectId("p1"))).toBe(0);
  });

  it("applies a SQL `where` predicate to filter results", async () => {
    const store = createVectorStore(join(tmp, "vectors"), identity, state);
    await store.upsertChunks([
      chunk("py1", unitVector(1, 0, 0, 0), {
        metadata: { language: "py", kind: "function", start_line: 1, end_line: 5, symbols: "" },
      }),
      chunk("ts1", unitVector(0.99, 0.01, 0, 0), {
        metadata: { language: "ts", kind: "function", start_line: 1, end_line: 5, symbols: "" },
      }),
    ]);

    const results = await store.query({
      embedding: unitVector(1, 0, 0, 0),
      k: 5,
      where: "language = 'py'",
    });
    expect(results.map((r) => r.chunkId)).toEqual(["py1"]);
  });
});
