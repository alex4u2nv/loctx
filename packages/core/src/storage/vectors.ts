/**
 * LanceDB-backed vector store with collection identity guards.
 *
 * Embedded, file-backed, no server process. The lancedb client is loaded
 * lazily via dynamic import so the rest of @loctx/core stays importable
 * without paying for native bindings up front.
 *
 * Layout: one Lance table per `EmbeddingIdentity` (different model →
 * different dimension → different table). The table name carries the
 * identity hash; the StateStore independently records which name maps
 * to which identity, so reusing a directory with a new model raises
 * `CollectionIdentityMismatch` before the first write.
 */

import { mkdirSync } from "node:fs";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import {
  type ChunkId,
  type EmbeddingIdentity,
  type FileId,
  type ProjectId,
  collectionSuffix,
} from "../models.js";
import type { StateStore } from "./state.js";

const TABLE_PREFIX = "loctx_";

export interface EmbeddedChunk {
  readonly chunkId: ChunkId;
  readonly fileId: FileId;
  readonly projectId: ProjectId;
  readonly relPath: string;
  readonly embedding: ReadonlyArray<number>;
  readonly document: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/**
 * SQL `WHERE` predicate over the columns written by `upsertChunks`:
 * `chunk_id`, `project_id`, `file_id`, `rel_path`, `language`, `kind`,
 * `start_line`, `end_line`, `symbols`. Pass strings as `'value'`.
 */
export interface VectorQuery {
  readonly embedding: ReadonlyArray<number>;
  readonly k?: number;
  readonly where?: string;
}

export interface VectorMatch {
  readonly chunkId: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly document: string;
}

export function collectionNameFor(identity: EmbeddingIdentity): string {
  return `${TABLE_PREFIX}${collectionSuffix(identity)}`;
}

// Minimal type sketch of the lancedb objects we touch. Pulling the real
// types in from `@lancedb/lancedb` would force every importer of
// @loctx/core to resolve the native bindings; the dynamic-import guard
// is the whole point.
interface LanceTable {
  add(records: ReadonlyArray<Record<string, unknown>>): Promise<unknown>;
  delete(predicate: string): Promise<unknown>;
  countRows(filter?: string): Promise<number>;
  mergeInsert(on: string | string[]): {
    whenMatchedUpdateAll(): {
      whenNotMatchedInsertAll(): {
        execute(records: ReadonlyArray<Record<string, unknown>>): Promise<unknown>;
      };
    };
  };
  search(vector: ReadonlyArray<number>): {
    distanceType(t: "l2" | "cosine" | "dot"): {
      where(predicate: string): {
        limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> };
      };
      limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> };
    };
  };
}

interface LanceConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable>;
  createEmptyTable(name: string, schema: Schema): Promise<LanceTable>;
}

interface LanceModule {
  connect(uri: string): Promise<LanceConnection>;
}

/**
 * Closure-bound factory for a vector store. The only persistent state is
 * the lazily-opened Lance table reference, which lives in the closure
 * rather than on a class instance — `this` ceremony bought nothing here.
 */
export interface VectorStore {
  readonly count: () => Promise<number>;
  readonly upsertChunks: (chunks: ReadonlyArray<EmbeddedChunk>) => Promise<void>;
  readonly deleteFileChunks: (projectId: ProjectId, relPath: string) => Promise<void>;
  readonly deleteProjectChunks: (projectId: ProjectId) => Promise<void>;
  readonly query: (request: VectorQuery) => Promise<VectorMatch[]>;
}

export function createVectorStore(
  vectorDir: string,
  identity: EmbeddingIdentity,
  state: StateStore,
): VectorStore {
  mkdirSync(vectorDir, { recursive: true });
  const collectionName = collectionNameFor(identity);
  state.registerCollection(collectionName, identity);

  let table: LanceTable | null = null;
  let openPromise: Promise<LanceTable> | null = null;

  /**
   * Lazy: opens (or creates) the Lance table on first use. Concurrent
   * first-callers share the same Promise — otherwise two of them race
   * to `createEmptyTable` and Lance throws "Table already exists".
   */
  const ready = (): Promise<LanceTable> => {
    if (table !== null) return Promise.resolve(table);
    if (openPromise !== null) return openPromise;
    openPromise = (async () => {
      const lancedb = (await import("@lancedb/lancedb")) as unknown as LanceModule;
      const db = await lancedb.connect(vectorDir);
      const names = await db.tableNames();
      table = names.includes(collectionName)
        ? await db.openTable(collectionName)
        : await db.createEmptyTable(collectionName, buildSchema(identity.dimension));
      return table;
    })();
    return openPromise;
  };

  // LanceDB's merge-insert / delete paths grab a writer lock per call and
  // give up with "Too many concurrent writers" after a short retry budget
  // (#142). The integrated daemon issues writes from two streams — the
  // watcher (debounced indexFile) and the reconciler (periodic indexProject)
  // — and on a workspace with N projects those streams race. Serialising
  // every write through this mutex turns the race into a clean queue;
  // reads stay parallel because they don't take a writer.
  const writeMutex = new AsyncMutex();

  const api: VectorStore = {
    count: async () => (await ready()).countRows(),

    upsertChunks: async (chunks) => {
      if (chunks.length === 0) return;
      const t = await ready();
      const records = chunks.map(toRecord);
      // mergeInsert on chunk_id gives "upsert by id" semantics: a re-indexed
      // chunk replaces its old row; new chunks are appended.
      await writeMutex.runExclusive(() =>
        t.mergeInsert("chunk_id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(records),
      );
    },

    deleteFileChunks: async (projectId, relPath) => {
      const t = await ready();
      await writeMutex.runExclusive(() =>
        t.delete(`project_id = ${quote(projectId)} AND rel_path = ${quote(relPath)}`),
      );
    },

    deleteProjectChunks: async (projectId) => {
      const t = await ready();
      await writeMutex.runExclusive(() => t.delete(`project_id = ${quote(projectId)}`));
    },

    query: async (request) => {
      const t = await ready();
      const limit = Math.max(1, request.k ?? 10);
      // Embeddings from Xenova/all-MiniLM-L6-v2 (and most sentence-transformers
      // models) are L2-normalized, so cosine ≡ dot ≡ 1 - L2²/2. We pin cosine
      // explicitly so the score below is interpretable across providers, even
      // ones that don't normalize.
      const search = t.search([...request.embedding]).distanceType("cosine");
      const stage = request.where !== undefined ? search.where(request.where) : search;
      const rows = await stage.limit(limit).toArray();
      return rows.map(toMatch);
    },
  };
  return api;
}

// ---- helpers -----------------------------------------------------------

function buildSchema(dimension: number): Schema {
  // FixedSizeList<Float32>[dim] is the canonical Lance vector layout. The
  // remaining columns are flat, not nested, so SQL `where` predicates work
  // without `unnest`.
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("file_id", new Utf8(), false),
    new Field("rel_path", new Utf8(), false),
    new Field("language", new Utf8(), true),
    new Field("kind", new Utf8(), true),
    new Field("symbols", new Utf8(), true),
    new Field("start_line", new Int32(), true),
    new Field("end_line", new Int32(), true),
    new Field("document", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(dimension, new Field("item", new Float32(), true)),
      false,
    ),
  ]);
}

function toRecord(c: EmbeddedChunk): Record<string, unknown> {
  const meta = c.metadata;
  return {
    chunk_id: c.chunkId,
    project_id: c.projectId,
    file_id: c.fileId,
    rel_path: c.relPath,
    language: stringOrNull(meta["language"]),
    kind: stringOrNull(meta["kind"]),
    symbols: stringOrNull(meta["symbols"]),
    start_line: numberOrNull(meta["start_line"]),
    end_line: numberOrNull(meta["end_line"]),
    document: c.document,
    vector: Array.from(c.embedding, Number),
  };
}

function toMatch(row: Record<string, unknown>): VectorMatch {
  // LanceDB returns `_distance` for vector queries — lower is closer.
  // With distanceType=cosine the value is in [0, 2]; map to [-1, 1] in the
  // same direction as the original implementation (`1 - distance`).
  const distance = typeof row["_distance"] === "number" ? (row["_distance"] as number) : 0;
  const { chunk_id, document, vector, _distance, ...rest } = row as Record<string, unknown> & {
    chunk_id?: unknown;
    document?: unknown;
  };
  void vector;
  void _distance;
  return {
    chunkId: String(chunk_id ?? ""),
    score: 1 - distance,
    metadata: Object.freeze(rest),
    document: typeof document === "string" ? document : "",
  };
}

function quote(s: string): string {
  // Single quote per ANSI SQL; escape embedded quotes by doubling.
  return `'${s.replace(/'/g, "''")}'`;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Minimal FIFO mutex. `runExclusive(fn)` queues `fn` after every prior
 * call's settlement so they run strictly serially. Failures are
 * isolated — the chain advances on both resolve and reject so a single
 * write rejection doesn't deadlock everything behind it.
 */
class AsyncMutex {
  private chain: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    // Continue the chain regardless of outcome.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
