/**
 * SQLite-backed state for projects, files, chunks, and collection identity.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  type EmbeddingIdentity,
  type FileId,
  type Project,
  type ProjectId,
  identityToString,
  projectId as toProjectId,
} from "../models.js";
import { loadQueries } from "../sql/loader.js";

export const SCHEMA_VERSION = 2;

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

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
  listProjects(): Array<Project & { readonly lastIndexedAt: string | null }> {
    type Row = { id: string; name: string; root: string; last_indexed_at: string | null };
    return this.readAll<Row>("list_projects").map((r) => ({
      id: toProjectId(r.id),
      name: r.name,
      root: r.root,
      lastIndexedAt: r.last_indexed_at,
    }));
  }

  markProjectIndexed(id: ProjectId, at: Date = new Date()): void {
    this.write("mark_project_indexed", [at.toISOString(), id]);
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
    const tx = this.db.transaction(() => {
      this.write("delete_chunks_fts_for_file", [fileId]);
      this.write("delete_chunks_for_file", [fileId]);
      for (const c of chunkArr) {
        const symbolsJoined = c.symbols.length > 0 ? c.symbols.join(",") : null;
        insertChunk.run(c.chunkId, c.fileId, c.startLine, c.endLine, c.kind, symbolsJoined);
        // FTS5 has no nullable distinction; pass empty strings rather than NULL.
        insertFts.run(c.chunkId, c.fileId, c.projectId, c.relPath, c.document, symbolsJoined ?? "");
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
