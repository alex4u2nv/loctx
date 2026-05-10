/**
 * SQLite-backed state for projects, files, chunks, and collection identity.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  type AnalyzerMetadata,
  type EmbeddingIdentity,
  type FileId,
  type Project,
  type ProjectId,
  type SymbolRef,
  type SymbolRefKind,
  analyzerMetadataFromJson,
  analyzerMetadataToJson,
  identityToString,
  chunkId as toChunkId,
  fileId as toFileId,
  projectId as toProjectId,
} from "../models.js";
import { loadQueries } from "../sql/loader.js";

export const SCHEMA_VERSION = 5;

const QUERIES = loadQueries("../sql/state.sql", import.meta.url);

export class CollectionIdentityMismatch extends Error {}

export interface FileState {
  readonly fileId: FileId;
  readonly projectId: ProjectId;
  readonly relPath: string;
  readonly size: number;
  readonly mtime: number;
  readonly contentSha: string;
  readonly indexedAt: string; // ISO-8601
  readonly embeddingIdentity: string;
  readonly error: string | null;
}

export interface ChunkState {
  readonly chunkId: string;
  readonly fileId: FileId;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
}

/**
 * Shape passed to {@link StateStore.replaceChunks} when (re-)indexing a file.
 * Carries everything needed to write both the chunks bookkeeping row and
 * the chunks_fts BM25 row in one transaction.
 *
 *   - inherits from {@link ChunkState}: chunk_id, file_id, lines, kind, symbols
 *   - `document`   — chunk body (the BM25-ranked column in chunks_fts)
 *   - `projectId`  — for FTS5 project-scoped filtering
 *   - `relPath`    — for FTS5 path-prefix filtering
 *
 * Listing chunks back via {@link StateStore.listChunks} returns the lighter
 * {@link ChunkState} only — the FTS5 index is the source of truth for
 * `document` content; we don't denormalize it onto the chunks table.
 */
export interface ChunkInsert extends ChunkState {
  readonly projectId: ProjectId;
  readonly relPath: string;
  readonly document: string;
  /** Optional AST metadata serialized to chunks.metadata_json. */
  readonly analyzer?: AnalyzerMetadata;
  /** Primary symbol the chunk defines, indexed for symbol lookup. */
  readonly symbolDef?: string;
  /**
   * Optional symbol references inside this chunk (#96). Each row gets
   * persisted to `symbol_refs` for the find_usages MCP tool. The
   * indexer fans `chunkId/fileId/projectId` onto each entry.
   */
  readonly symbolRefs?: ReadonlyArray<{
    readonly symbol: string;
    readonly kind: SymbolRefKind;
    readonly line: number;
  }>;
}

/** Input for {@link StateStore.searchLexical}. */
export interface LexicalQuery {
  readonly query: string;
  readonly limit?: number;
  /** Restrict to a single project. Required when `relPathPrefix` is set. */
  readonly projectId?: string;
  /** Restrict to documents whose `rel_path` starts with this prefix (e.g. `src/auth/`). */
  readonly relPathPrefix?: string;
}

/**
 * One file's contribution to a duplicate group (#65). Coordinates are
 * absolute file lines (1-based, inclusive). The full file path can be
 * resolved through the StateStore's `files` table by `fileId`.
 */
export interface DuplicateMember {
  readonly fileId: FileId;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * A group of duplicate windows that share the same content hash across
 * at least 2 files. Surfaced by `StateStore.findDuplicateGroups`.
 */
export interface DuplicateGroup {
  readonly hash: string;
  readonly members: ReadonlyArray<DuplicateMember>;
}

/**
 * Persisted result from a background analyzer (#61, #62). One row per
 * (file_id, analyzer). `payloadJson` carries the analyzer-specific
 * findings; the schema is the analyzer's contract, not loctx's.
 */
export interface FileEnrichmentRow {
  readonly fileId: FileId;
  readonly analyzer: string;
  readonly analyzerVersion: number;
  /** Hash of the file content the result was computed against. */
  readonly contentSha: string;
  readonly status: "complete" | "failed" | "skipped";
  readonly payloadJson?: string;
  readonly error?: string;
  readonly enqueuedAt?: string;
  readonly completedAt?: string;
}

/**
 * A row of {@link StateStore.findSymbol} output. Joins symbol_refs with
 * files + chunks so the MCP `find_usages` response is one call away
 * from a jump target (rel_path + line + surrounding chunk range).
 */
export interface SymbolRefHit extends SymbolRef {
  readonly relPath: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
}

/** A BM25-ranked match returned by {@link StateStore.searchLexical}. */
export interface LexicalMatch {
  readonly chunkId: string;
  readonly fileId: FileId;
  readonly projectId: ProjectId;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
  readonly document: string;
  /** SQLite BM25 rank — lower is a better match. */
  readonly rank: number;
}

export class StateStore {
  private readonly db: Database.Database;
  private readonly stmts = new Map<string, Database.Statement>();

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(QUERIES["pragma_enable_foreign_keys"] ?? "PRAGMA foreign_keys = ON");
    this.db.exec(QUERIES["pragma_journal_wal"] ?? "PRAGMA journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ---- internals ------------------------------------------------------

  private prepare(name: string): Database.Statement {
    const cached = this.stmts.get(name);
    if (cached !== undefined) return cached;
    const text = QUERIES[name];
    if (text === undefined) throw new Error(`Unknown SQL section: ${name}`);
    const stmt = this.db.prepare(text);
    this.stmts.set(name, stmt);
    return stmt;
  }

  private write(name: string, params: ReadonlyArray<unknown> = []): void {
    this.prepare(name).run(...params);
  }

  private readOne<T>(name: string, params: ReadonlyArray<unknown> = []): T | undefined {
    return this.prepare(name).get(...params) as T | undefined;
  }

  private readAll<T>(name: string, params: ReadonlyArray<unknown> = []): T[] {
    return this.prepare(name).all(...params) as T[];
  }

  // ---- schema ---------------------------------------------------------

  private migrate(): void {
    const pragmaText = QUERIES["pragma_get_user_version"] ?? "PRAGMA user_version";
    const row = this.db.prepare(pragmaText).get() as { user_version: number } | undefined;
    const current = row?.user_version ?? 0;
    if (current >= SCHEMA_VERSION) return;

    if (current < 1) {
      const schemaV1 = QUERIES["schema_v1"];
      if (schemaV1 === undefined) throw new Error("Missing schema_v1 in state.sql");
      this.db.exec(schemaV1);
    }
    if (current < 2) {
      const schemaV2 = QUERIES["schema_v2"];
      if (schemaV2 === undefined) throw new Error("Missing schema_v2 in state.sql");
      this.db.exec(schemaV2);
    }
    if (current < 3) {
      const schemaV3 = QUERIES["schema_v3"];
      if (schemaV3 === undefined) throw new Error("Missing schema_v3 in state.sql");
      this.db.exec(schemaV3);
    }
    if (current < 4) {
      const schemaV4 = QUERIES["schema_v4"];
      if (schemaV4 === undefined) throw new Error("Missing schema_v4 in state.sql");
      // schema_v4 ADDs `projects.last_reconciled_at`. SQLite has no
      // `ADD COLUMN IF NOT EXISTS`, and the column may already exist if
      // the DB was opened by a newer build then walked back via PRAGMA
      // user_version (test-suite scenario, plus possible downgrade).
      // Skip the ALTER when the column is present.
      if (!this.columnExists("projects", "last_reconciled_at")) {
        this.db.exec(schemaV4);
      }
    }

    if (current < 5) {
      const schemaV5 = QUERIES["schema_v5"];
      if (schemaV5 === undefined) throw new Error("Missing schema_v5 in state.sql");
      this.db.exec(schemaV5);
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  // ---- projects -------------------------------------------------------

  upsertProject(project: Project): void {
    this.write("upsert_project", [project.id, project.name, project.root]);
  }

  getProject(id: ProjectId): Project | null {
    type Row = { id: string; name: string; root: string };
    const row = this.readOne<Row>("get_project", [id]);
    if (row === undefined) return null;
    return { id: toProjectId(row.id), name: row.name, root: row.root };
  }

  /**
   * Every project ever indexed in this store, ordered by root path.
   * `lastIndexedAt` is null when the project row exists but has not been
   * marked indexed (e.g. discovered then aborted).
   */
  listProjects(): Array<
    Project & { readonly lastIndexedAt: string | null; readonly lastReconciledAt: string | null }
  > {
    type Row = {
      id: string;
      name: string;
      root: string;
      last_indexed_at: string | null;
      last_reconciled_at: string | null;
    };
    return this.readAll<Row>("list_projects").map((r) => ({
      id: toProjectId(r.id),
      name: r.name,
      root: r.root,
      lastIndexedAt: r.last_indexed_at,
      lastReconciledAt: r.last_reconciled_at,
    }));
  }

  markProjectIndexed(id: ProjectId, at: Date = new Date()): void {
    this.write("mark_project_indexed", [at.toISOString(), id]);
  }

  markProjectReconciled(id: ProjectId, at: Date = new Date()): void {
    this.write("mark_project_reconciled", [at.toISOString(), id]);
  }

  /**
   * Delete every row associated with a project: chunks_fts, chunks, files,
   * and the project itself, in one transaction. The vector store is the
   * caller's responsibility (see VectorStore.deleteProjectChunks).
   */
  deleteProject(id: ProjectId): void {
    const tx = this.db.transaction(() => {
      this.write("delete_chunks_fts_for_project", [id]);
      this.write("delete_chunks_for_project", [id]);
      this.write("delete_symbol_refs_for_project", [id]);
      this.write("delete_files_for_project", [id]);
      this.write("delete_project", [id]);
    });
    tx();
  }

  // ---- files ----------------------------------------------------------

  upsertFile(state: FileState): void {
    this.write("upsert_file", [
      state.fileId,
      state.projectId,
      state.relPath,
      state.size,
      state.mtime,
      state.contentSha,
      state.indexedAt,
      state.embeddingIdentity,
      state.error,
    ]);
  }

  getFile(projectId: ProjectId, relPath: string): FileState | null {
    const row = this.readOne<FileRow>("get_file", [projectId, relPath]);
    return row === undefined ? null : fileStateFromRow(row);
  }

  listFiles(projectId: ProjectId): FileState[] {
    return this.readAll<FileRow>("list_files", [projectId]).map(fileStateFromRow);
  }

  /**
   * Delete a file row + cascade to chunks + chunks_fts in one transaction.
   * Without the cascade, watcher "unlink" events would leave orphaned chunk
   * and FTS rows that no later replaceChunks call could clean up (the file_id
   * is unrecoverable once the file row is gone).
   */
  deleteFile(projectId: ProjectId, relPath: string): void {
    const file = this.getFile(projectId, relPath);
    if (file === null) return;
    const tx = this.db.transaction(() => {
      this.write("delete_chunks_fts_for_file", [file.fileId]);
      this.write("delete_chunks_for_file", [file.fileId]);
      this.write("delete_symbol_refs_for_file", [file.fileId]);
      this.write("delete_file", [projectId, relPath]);
    });
    tx();
  }

  // ---- chunks ---------------------------------------------------------

  /**
   * Replace every chunk row for `fileId` in a single transaction. Writes
   * both the chunks bookkeeping table and the chunks_fts BM25 index so
   * lexical search stays consistent with vector search.
   */
  replaceChunks(fileId: FileId, chunks: Iterable<ChunkInsert>): void {
    const chunkArr = [...chunks];
    const insertChunk = this.prepare("insert_chunk");
    const insertFts = this.prepare("insert_chunk_fts");
    const insertSymbolRef = this.prepare("insert_symbol_ref");
    const tx = this.db.transaction(() => {
      this.write("delete_chunks_fts_for_file", [fileId]);
      this.write("delete_chunks_for_file", [fileId]);
      this.write("delete_symbol_refs_for_file", [fileId]);
      for (const c of chunkArr) {
        const symbolsJoined = c.symbols.length > 0 ? c.symbols.join(",") : null;
        // metadata_json + symbol_def written inline. The chunker (#59)
        // populates analyzer when tree-sitter has a profile for the
        // language; non-code chunks (markdown, line-window) leave it
        // undefined and we store NULL.
        const metadataJson = c.analyzer !== undefined ? analyzerMetadataToJson(c.analyzer) : null;
        const symbolDef = c.symbolDef ?? c.symbols[0] ?? null;
        insertChunk.run(
          c.chunkId,
          c.fileId,
          c.startLine,
          c.endLine,
          c.kind,
          symbolsJoined,
          metadataJson,
          symbolDef,
        );
        // FTS5 has no nullable distinction; pass empty strings rather than NULL.
        insertFts.run(c.chunkId, c.fileId, c.projectId, c.relPath, c.document, symbolsJoined ?? "");
        if (c.symbolRefs !== undefined) {
          for (const ref of c.symbolRefs) {
            insertSymbolRef.run(ref.symbol, c.projectId, c.fileId, c.chunkId, ref.line, ref.kind);
          }
        }
      }
    });
    tx();
  }

  listChunks(fileId: FileId): ChunkState[] {
    return this.readAll<ChunkRow>("list_chunks", [fileId]).map(chunkStateFromRow);
  }

  // ---- lexical search (FTS5 / BM25) -----------------------------------

  /**
   * BM25-ranked match over chunks_fts JOIN chunks. The FTS5 MATCH expression
   * is the user's query; project + path-prefix predicates are pushed into
   * SQL so subtree-scoped queries don't lose the top-ranked global hits the
   * way a host-side post-filter does.
   *
   * Lower `rank` = better match (SQLite BM25 returns negative weights; the
   * fewer the better). Callers that fuse with vector results should
   * normalize via reciprocal rank — see WorkspaceSearcher.
   */
  searchLexical(query: LexicalQuery): LexicalMatch[] {
    const limit = Math.max(1, query.limit ?? 50);
    if (query.relPathPrefix !== undefined) {
      const params = [query.query, query.projectId ?? "", `${query.relPathPrefix}%`, limit];
      return this.readAll<LexicalRow>("search_lexical_subtree", params).map(lexicalMatchFromRow);
    }
    if (query.projectId !== undefined) {
      const params = [query.query, query.projectId, limit];
      return this.readAll<LexicalRow>("search_lexical_project", params).map(lexicalMatchFromRow);
    }
    return this.readAll<LexicalRow>("search_lexical_all", [query.query, limit]).map(
      lexicalMatchFromRow,
    );
  }

  // ---- symbol cross-references (#96) ---------------------------------

  /**
   * Look up a symbol's definitions and references inside a single project.
   * Definitions are kind=`def`; everything else (call/import/reference)
   * lands in `refs`. Both arrays come back sorted by file/line so
   * consumers can render them top-to-bottom without re-sorting. Empty
   * arrays when nothing matches — never throws on "not found".
   *
   * `relPath` and the chunk's surrounding line range come back joined
   * from `files` + `chunks` so the find_usages MCP tool can emit jump
   * targets without an extra round-trip.
   */
  findSymbol(
    projectId: ProjectId,
    symbol: string,
  ): { defs: ReadonlyArray<SymbolRefHit>; refs: ReadonlyArray<SymbolRefHit> } {
    const rows = this.readAll<SymbolRefRow>("find_symbol_in_project", [projectId, symbol]);
    const defs: SymbolRefHit[] = [];
    const refs: SymbolRefHit[] = [];
    for (const row of rows) {
      const hit = symbolRefHitFromRow(row);
      if (hit.kind === "def") defs.push(hit);
      else refs.push(hit);
    }
    return { defs: Object.freeze(defs), refs: Object.freeze(refs) };
  }

  // ---- analyzer metadata ----------------------------------------------

  /**
   * Batch-fetch analyzer metadata for the given chunk ids. Returns a map
   * keyed by chunk_id; missing chunks (or chunks indexed before v3) map
   * to null. SQLite has no array bind, so we materialise N positional
   * placeholders inline. The id list is internally generated (chunk ids
   * from a search result), not user input — no injection surface.
   */
  getAnalyzersByChunkIds(chunkIds: ReadonlyArray<string>): Map<string, AnalyzerMetadata | null> {
    const result = new Map<string, AnalyzerMetadata | null>();
    if (chunkIds.length === 0) return result;
    const placeholders = chunkIds.map(() => "?").join(",");
    const sql = `SELECT chunk_id, metadata_json FROM chunks WHERE chunk_id IN (${placeholders})`;
    const rows = this.db.prepare(sql).all(...chunkIds) as Array<{
      chunk_id: string;
      metadata_json: string | null;
    }>;
    for (const row of rows) {
      result.set(row.chunk_id, analyzerMetadataFromJson(row.metadata_json));
    }
    return result;
  }

  // ---- duplicates aggregation (#65) -----------------------------------

  /**
   * Cross-file aggregation of duplicate windows. Reads every
   * `duplicates` enrichment row, groups windows by hash, and returns
   * groups that hit at least `minMembers` distinct files. The
   * per-file payloads are written by the duplicates analyzer; the
   * grouping happens here at query time so we don't pay an N² cost
   * during indexing. Output is sorted by group size (most-duplicated
   * first).
   */
  findDuplicateGroups(minMembers = 2): DuplicateGroup[] {
    const rows = this.readAll<{ file_id: string; payload_json: string | null }>(
      "list_file_enrichments_by_analyzer",
      ["duplicates"],
    );
    const byHash = new Map<string, DuplicateMember[]>();
    for (const row of rows) {
      if (row.payload_json === null) continue;
      let payload: {
        windows?: ReadonlyArray<{ hash: string; startLine: number; endLine: number }>;
      };
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      for (const w of payload.windows ?? []) {
        const list = byHash.get(w.hash) ?? [];
        list.push({
          fileId: row.file_id as FileId,
          startLine: w.startLine,
          endLine: w.endLine,
        });
        byHash.set(w.hash, list);
      }
    }
    const groups: DuplicateGroup[] = [];
    for (const [hash, members] of byHash.entries()) {
      const distinctFiles = new Set(members.map((m) => m.fileId));
      if (distinctFiles.size < minMembers) continue;
      groups.push({ hash, members: Object.freeze(members) });
    }
    return groups.sort((a, b) => b.members.length - a.members.length);
  }

  // ---- file enrichments (#61, #62) ------------------------------------

  /**
   * Persist a background analyzer's result for a single (file, analyzer)
   * pair. Upserts on conflict so re-running the analyzer overwrites
   * the previous payload. Caller serialises the payload to JSON.
   */
  upsertFileEnrichment(row: FileEnrichmentRow): void {
    this.write("upsert_file_enrichment", [
      row.fileId,
      row.analyzer,
      row.analyzerVersion,
      row.contentSha,
      row.status,
      row.payloadJson ?? null,
      row.error ?? null,
      row.enqueuedAt ?? null,
      row.completedAt ?? null,
    ]);
  }

  getFileEnrichment(fileId: FileId, analyzer: string): FileEnrichmentRow | null {
    const row = this.readOne<{
      analyzer: string;
      analyzer_version: number;
      content_sha: string;
      status: string;
      payload_json: string | null;
      error: string | null;
      enqueued_at: string | null;
      completed_at: string | null;
    }>("get_file_enrichment", [fileId, analyzer]);
    if (row === undefined) return null;
    const out: FileEnrichmentRow = {
      fileId,
      analyzer: row.analyzer,
      analyzerVersion: row.analyzer_version,
      contentSha: row.content_sha,
      status: row.status as FileEnrichmentRow["status"],
      ...(row.payload_json !== null ? { payloadJson: row.payload_json } : {}),
      ...(row.error !== null ? { error: row.error } : {}),
      ...(row.enqueued_at !== null ? { enqueuedAt: row.enqueued_at } : {}),
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    };
    return out;
  }

  // ---- collections ----------------------------------------------------

  registerCollection(name: string, identity: EmbeddingIdentity): void {
    const target = identityToString(identity);
    const existing = this.getCollectionIdentity(name);
    if (existing === null) {
      this.write("insert_collection", [name, target, new Date().toISOString()]);
      return;
    }
    if (existing !== target) {
      throw new CollectionIdentityMismatch(
        `Collection '${name}' is registered with identity '${existing}'; refusing to reuse with '${target}'. Run \`loctx reset --index\` or pick a different model.`,
      );
    }
  }

  getCollectionIdentity(name: string): string | null {
    const row = this.readOne<{ identity: string }>("get_collection_identity", [name]);
    return row === undefined ? null : row.identity;
  }
}

// ---- row mappings -------------------------------------------------------

interface FileRow {
  file_id: string;
  project_id: string;
  rel_path: string;
  size: number;
  mtime: number;
  content_sha: string;
  indexed_at: string;
  embedding_identity: string;
  error: string | null;
}

interface ChunkRow {
  chunk_id: string;
  file_id: string;
  start_line: number;
  end_line: number;
  kind: string;
  symbols: string | null;
}

interface LexicalRow {
  chunk_id: string;
  file_id: string;
  project_id: string;
  rel_path: string;
  document: string;
  symbols: string | null;
  start_line: number;
  end_line: number;
  kind: string;
  rank: number;
}

interface SymbolRefRow {
  symbol: string;
  project_id: string;
  file_id: string;
  chunk_id: string;
  line: number;
  kind: string;
  rel_path: string;
  chunk_start: number;
  chunk_end: number;
}

function symbolRefHitFromRow(row: SymbolRefRow): SymbolRefHit {
  return Object.freeze({
    symbol: row.symbol,
    projectId: toProjectId(row.project_id),
    fileId: toFileId(row.file_id),
    chunkId: toChunkId(row.chunk_id),
    line: row.line,
    kind: row.kind as SymbolRefKind,
    relPath: row.rel_path,
    chunkStartLine: row.chunk_start,
    chunkEndLine: row.chunk_end,
  });
}

function lexicalMatchFromRow(row: LexicalRow): LexicalMatch {
  return {
    chunkId: row.chunk_id,
    fileId: row.file_id as FileId,
    projectId: row.project_id as ProjectId,
    relPath: row.rel_path,
    startLine: row.start_line,
    endLine: row.end_line,
    kind: row.kind,
    symbols:
      row.symbols !== null && row.symbols !== ""
        ? Object.freeze(row.symbols.split(",").filter((s) => s !== ""))
        : Object.freeze([]),
    document: row.document,
    rank: row.rank,
  };
}

function fileStateFromRow(row: FileRow): FileState {
  return {
    fileId: row.file_id as FileId,
    projectId: row.project_id as ProjectId,
    relPath: row.rel_path,
    size: row.size,
    mtime: row.mtime,
    contentSha: row.content_sha,
    indexedAt: row.indexed_at,
    embeddingIdentity: row.embedding_identity,
    error: row.error,
  };
}

function chunkStateFromRow(row: ChunkRow): ChunkState {
  return {
    chunkId: row.chunk_id,
    fileId: row.file_id as FileId,
    startLine: row.start_line,
    endLine: row.end_line,
    kind: row.kind,
    symbols: row.symbols ? Object.freeze(row.symbols.split(",")) : Object.freeze([]),
  };
}
