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
  collectionSuffix,
  type EmbeddingIdentity,
  type FileId,
  type ProjectId,
} from "../models.js";
import { quoteSql as quote } from "./quote.js";
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

/** One row of {@link VectorStore.scanChunks}: chunk identity + its vector. */
export interface ScannedChunk {
  readonly chunkId: string;
  readonly fileId: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Float32 view, passed through zero-copy where Lance already gives one. */
  readonly vector: Float32Array;
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
  createIndex(column: string, options?: { replace?: boolean }): Promise<void>;
  listIndices(): Promise<Array<{ name?: string; columns?: ReadonlyArray<string> }>>;
  optimize(options?: { cleanupOlderThan?: Date; deleteUnverified?: boolean }): Promise<unknown>;
  mergeInsert(on: string | string[]): {
    whenMatchedUpdateAll(): {
      whenNotMatchedInsertAll(): {
        execute(records: ReadonlyArray<Record<string, unknown>>): Promise<unknown>;
      };
    };
  };
  query(): LanceQueryBuilder;
  search(vector: ReadonlyArray<number>): {
    distanceType(t: "l2" | "cosine" | "dot"): {
      where(predicate: string): {
        limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> };
      };
      limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> };
    };
  };
}

/** Chainable non-vector scan (lancedb `table.query()`), minimally sketched. */
interface LanceQueryBuilder {
  where(predicate: string): LanceQueryBuilder;
  select(columns: ReadonlyArray<string>): LanceQueryBuilder;
  limit(n: number): LanceQueryBuilder;
  toArray(): Promise<Array<Record<string, unknown>>>;
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
  /**
   * Non-vector scan returning chunk identities WITH their embeddings,
   * for query-time analysis over the stored vectors (semantic
   * near-duplicates, #523). Row-capped by `limit` — callers must treat
   * a full page as "possibly truncated" and say so. Read-only; does not
   * take the writer mutex.
   */
  readonly scanChunks: (opts: {
    readonly projectId?: ProjectId;
    readonly limit: number;
  }) => Promise<ScannedChunk[]>;
  /**
   * Build a vector index (LanceDB picks the kind — typically IVF_PQ
   * or HNSW depending on dimension) when the corpus has grown past
   * `minRowsForIndex`. No-op when the corpus is small enough that
   * flat scan is faster than the index, or when an index is already
   * present. Cheap to call repeatedly — protected by a "last
   * checked" gate. See #210.
   */
  readonly ensureVectorIndex: (
    minRowsForIndex?: number,
  ) => Promise<{ built: boolean; rows: number }>;
  /**
   * Compact the Lance dataset: merge the per-upsert fragments and prune old
   * version manifests (#index-size). LanceDB is append-only — every
   * upsert/delete writes a new fragment + version, and nothing is reclaimed
   * until this runs. On a long-lived daemon the `_versions` history dwarfs
   * the live data (observed 5.9 GB of history over 179 MB of data). Runs
   * through the writer mutex so it's serialized with upserts/deletes; the
   * daemon is the sole writer, so `deleteUnverified` is safe here.
   */
  readonly compact: () => Promise<void>;
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

    scanChunks: async (opts) => {
      const t = await ready();
      const limit = Math.max(1, opts.limit);
      let builder = t
        .query()
        .select(["chunk_id", "file_id", "rel_path", "start_line", "end_line", "vector"]);
      if (opts.projectId !== undefined) {
        builder = builder.where(`project_id = ${quote(opts.projectId)}`);
      }
      const rows = await builder.limit(limit).toArray();
      // Lance has no ORDER BY on plain scans; sort by chunk_id so the
      // same fetched set always yields the same output order.
      return rows.map(toScannedChunk).sort((a, b) => a.chunkId.localeCompare(b.chunkId));
    },

    ensureVectorIndex: async (minRowsForIndex = 10_000) => {
      const t = await ready();
      const rows = await t.countRows();
      if (rows < minRowsForIndex) return { built: false, rows };
      try {
        const indices = await t.listIndices();
        const alreadyIndexed = indices.some((ix) => ix.columns?.includes("vector") ?? false);
        if (alreadyIndexed) return { built: false, rows };
        // `replace: false` so a concurrent caller doesn't blow away
        // an in-progress build. Goes through the writer mutex
        // because LanceDB serializes index work behind the same
        // lock as inserts/deletes.
        await writeMutex.runExclusive(() => t.createIndex("vector", { replace: false }));
        return { built: true, rows };
      } catch (err) {
        // Index build can fail if the data is too small for the
        // chosen algorithm, or if the version of LanceDB rejects
        // the call shape. Log and continue — search still works
        // via flat scan.
        console.error(`[vectors] createIndex skipped: ${(err as Error).message}`);
        return { built: false, rows };
      }
    },

    compact: async () => {
      const t = await ready();
      await writeMutex.runExclusive(() =>
        // cleanupOlderThan: now → prune every version except the current one.
        // deleteUnverified: true → also remove files < 7 days old (the whole
        // point — that's where the bloat is). Safe because we hold the writer
        // mutex and the daemon is the only process writing this dataset.
        t.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true }),
      );
    },
  };
  return api;
}

/**
 * Delete a project's vector rows from every named collection that
 * actually exists on disk. Identity-free: the collection names come
 * from the state DB's registry (`StateStore.listCollections()`), so
 * callers never need an embedding model to derive a table name. That
 * makes it the right delete for maintenance paths like the CLI's
 * no-daemon `purge` (#448) — and unlike an identity-derived delete, it
 * also reaches rows written under a previous embedding model.
 *
 * Returns the number of collections a delete ran against.
 */
export async function purgeProjectVectors(
  vectorDir: string,
  collectionNames: ReadonlyArray<string>,
  projectId: ProjectId,
): Promise<number> {
  if (collectionNames.length === 0) return 0;
  const lancedb = (await import("@lancedb/lancedb")) as unknown as LanceModule;
  let db: LanceConnection;
  try {
    db = await lancedb.connect(vectorDir);
  } catch {
    // No vector directory yet — nothing indexed, nothing to purge.
    return 0;
  }
  const existing = new Set(await db.tableNames());
  let touched = 0;
  for (const name of collectionNames) {
    if (!existing.has(name)) continue;
    const table = await db.openTable(name);
    await table.delete(`project_id = ${quote(projectId)}`);
    touched += 1;
  }
  return touched;
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

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Map a scan row to {@link ScannedChunk}. Lance surfaces the
 * FixedSizeList vector as an iterable (typed array or Arrow vector
 * depending on version) — Array.from normalizes either.
 */
function toScannedChunk(row: Record<string, unknown>): ScannedChunk {
  return {
    chunkId: String(row["chunk_id"] ?? ""),
    fileId: String(row["file_id"] ?? ""),
    relPath: String(row["rel_path"] ?? ""),
    startLine: numberOrNull(row["start_line"]) ?? 0,
    endLine: numberOrNull(row["end_line"]) ?? 0,
    vector: toFloat32(row["vector"]),
  };
}

/** Zero-copy when Lance already hands back a Float32Array; one copy otherwise. */
function toFloat32(vec: unknown): Float32Array {
  if (vec instanceof Float32Array) return vec;
  if (
    vec !== null &&
    vec !== undefined &&
    typeof (vec as Iterable<number>)[Symbol.iterator] === "function"
  ) {
    return Float32Array.from(vec as Iterable<number>);
  }
  return new Float32Array(0);
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
