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

export const SCHEMA_VERSION = 1;

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
    const schema = QUERIES["schema_v1"];
    if (schema === undefined) throw new Error("Missing schema_v1 in state.sql");
    this.db.exec(schema);
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

  deleteFile(projectId: ProjectId, relPath: string): void {
    this.write("delete_file", [projectId, relPath]);
  }

  // ---- chunks ---------------------------------------------------------

  replaceChunks(fileId: FileId, chunks: Iterable<ChunkState>): void {
    const chunkArr = [...chunks];
    const insert = this.prepare("insert_chunk");
    const tx = this.db.transaction(() => {
      this.write("delete_chunks_for_file", [fileId]);
      for (const c of chunkArr) {
        insert.run(
          c.chunkId,
          c.fileId,
          c.startLine,
          c.endLine,
          c.kind,
          c.symbols.length > 0 ? c.symbols.join(",") : null,
        );
      }
    });
    tx();
  }

  listChunks(fileId: FileId): ChunkState[] {
    return this.readAll<ChunkRow>("list_chunks", [fileId]).map(chunkStateFromRow);
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
