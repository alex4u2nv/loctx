import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChunkId,
  type EmbeddingIdentity,
  type FileId,
  type ProjectId,
  chunkId,
  fileId,
  projectId,
} from "../../src/models.js";
import { StateStore } from "../../src/storage/state.js";
import { type EmbeddedChunk, createVectorStore } from "../../src/storage/vectors.js";
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
