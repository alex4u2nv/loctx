/**
 * SQLite-backed state for projects, files, chunks, and collection identity.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  type AnalyzerMetadata,
  analyzerMetadataFromJson,
  analyzerMetadataToJson,
  type EmbeddingIdentity,
  type FileId,
  identityToString,
  type Project,
  type ProjectId,
  type SymbolRef,
  type SymbolRefKind,
  chunkId as toChunkId,
  fileId as toFileId,
  projectId as toProjectId,
} from "../models.js";
import { loadQueries } from "../sql/loader.js";

export const SCHEMA_VERSION = 8;

/**
 * Raised when the on-disk schema version is newer than this build's
 * `SCHEMA_VERSION` — i.e. the user downgraded loctx. We refuse to open
 * the DB rather than blindly write through it, because newer schemas
 * may have columns this build doesn't know to populate.
 */
export class SchemaTooNewError extends Error {}

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
  readonly document: string;
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

/**
 * One row to persist for an MCP `tools/call` (#380-era). The registry
 * dispatch builds this from the request + handler result so the admin
 * "logs" page can show real agent traffic for quality tuning. The
 * payloads are stored verbatim — full request arguments + full response
 * — capped only by the row-count bound (`mcp.log_max_rows`).
 */
export interface McpRequestLogInput {
  readonly tool: string;
  /** Full request arguments, JSON-serialized. */
  readonly argumentsJson: string;
  /** Full response payload, JSON-serialized. Null when the call errored. */
  readonly responseJson: string | null;
  /** Error message when the call failed. Null on success. */
  readonly error: string | null;
  readonly ok: boolean;
  readonly elapsedMs: number;
  /** Defaults to now. */
  readonly requestedAt?: string;
}

/** A persisted MCP request row read back by {@link StateStore.listMcpRequests}. */
export interface McpRequestLogEntry extends McpRequestLogInput {
  readonly id: number;
  readonly requestedAt: string;
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

  private write(name: string, params: ReadonlyArray<unknown> = []): { changes: number } {
    const result = this.prepare(name).run(...params);
    return { changes: typeof result.changes === "number" ? result.changes : 0 };
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
    if (current > SCHEMA_VERSION) {
      // A previous, newer loctx opened this DB and migrated the schema
      // forward. Writing through with an older codebase would silently
      // skip columns / tables that we don't know exist. Refuse with a
      // recovery hint instead of corrupting data.
      throw new SchemaTooNewError(
        `state DB schema is version ${current}; this build only knows up to ${SCHEMA_VERSION}. You're running an older loctx than the one that last touched this data dir. Upgrade loctx, or reset the index with \`loctx reset index --force\` and re-run \`loctx index\`.`,
      );
    }
    // Sanity check on partial migrations: if user_version says we've
    // been here before but a required table is missing, the DB has
    // been hand-edited or partially corrupted. ALTERing a missing
    // table yields a cryptic error; refuse upfront with a clearer
    // recovery hint. Skips the brand-new case (current === 0).
    // See #187.
    if (current > 0) {
      const missing = this.missingRequiredTables();
      if (missing.length > 0) {
        throw new Error(
          `state DB at user_version=${current} is missing tables: ${missing.join(", ")}. Run \`loctx reset index --force\` to recreate, or restore from backup.`,
        );
      }
    }
    if (current === SCHEMA_VERSION) return;

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
      // schema_v3 ALTERs `chunks` to add `metadata_json` + `symbol_def`,
      // and CREATEs `symbol_refs` + indices. The CREATEs use
      // `IF NOT EXISTS`, but the ALTERs don't have that option in
      // SQLite. Guard them the same way v4 and v6 already do so a
      // downgrade-then-reupgrade scenario (or test sandbox that
      // walks user_version backwards) doesn't trip "duplicate
      // column" errors. See #196.
      if (
        !this.columnExists("chunks", "metadata_json") ||
        !this.columnExists("chunks", "symbol_def")
      ) {
        this.db.exec(schemaV3);
      } else {
        // Columns already present; still need to (re-)create
        // symbol_refs + indices. Those use IF NOT EXISTS so it's
        // safe to run the whole block — but we can't run it without
        // the ALTERs failing. Split: run only the CREATEs.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS symbol_refs (
            symbol TEXT NOT NULL,
            project_id TEXT NOT NULL,
            file_id TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            line INTEGER NOT NULL,
            kind TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_symbol_refs_lookup
              ON symbol_refs(project_id, symbol, kind);
          CREATE INDEX IF NOT EXISTS idx_symbol_refs_chunk ON symbol_refs(chunk_id);
          CREATE INDEX IF NOT EXISTS idx_chunks_symbol_def ON chunks(symbol_def);
        `);
      }
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

    if (current < 6) {
      const schemaV6 = QUERIES["schema_v6"];
      if (schemaV6 === undefined) throw new Error("Missing schema_v6 in state.sql");
      // schema_v6 adds `projects.active`. Same SQLite gotcha as v4:
      // skip the ALTER when the column already exists (test sandbox
      // walks user_version backwards between cases).
      if (!this.columnExists("projects", "active")) {
        this.db.exec(schemaV6);
      }
    }

    if (current < 7) {
      const schemaV7 = QUERIES["schema_v7"];
      if (schemaV7 === undefined) throw new Error("Missing schema_v7 in state.sql");
      // schema_v7 adds `projects.rebuild_pending_at`. Same SQLite gotcha:
      // skip when the column already exists.
      if (!this.columnExists("projects", "rebuild_pending_at")) {
        this.db.exec(schemaV7);
      }
    }

    if (current < 8) {
      const schemaV8 = QUERIES["schema_v8"];
      if (schemaV8 === undefined) throw new Error("Missing schema_v8 in state.sql");
      // schema_v8 adds the mcp_requests table + index. Both use
      // IF NOT EXISTS, so the block is safe to re-run on a sandbox that
      // walks user_version backwards between cases.
      this.db.exec(schemaV8);
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  /**
   * Subset of expected tables for a partially-migrated DB. The list is
   * the v1 baseline (`projects`, `files`, `chunks`, `collections`) —
   * tables added in later migrations are checked by `columnExists`
   * lower down. Returning a non-empty list means the DB has been
   * tampered with or partially corrupted. See #187.
   */
  private missingRequiredTables(): string[] {
    const required = ["projects", "files", "chunks", "collections"];
    const present = new Set(
      (
        this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    return required.filter((t) => !present.has(t));
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
   * Every project ever known to this store, ordered by root path.
   * `lastIndexedAt` is null when the project row exists but has not been
   * marked indexed (e.g. discovered then aborted).
   *
   * `active` distinguishes user-activated projects from inactive ones
   * (discovered but never opted in). Pre-v6 rows migrate to active=1;
   * new rows default to active=0 until `setProjectActive(id, true)`.
   */
  listProjects(): Array<
    Project & {
      readonly lastIndexedAt: string | null;
      readonly lastReconciledAt: string | null;
      readonly active: boolean;
    }
  > {
    type Row = {
      id: string;
      name: string;
      root: string;
      last_indexed_at: string | null;
      last_reconciled_at: string | null;
      active: number;
    };
    return this.readAll<Row>("list_projects").map((r) => ({
      id: toProjectId(r.id),
      name: r.name,
      root: r.root,
      lastIndexedAt: r.last_indexed_at,
      lastReconciledAt: r.last_reconciled_at,
      active: r.active !== 0,
    }));
  }

  markProjectIndexed(id: ProjectId, at: Date = new Date()): void {
    this.write("mark_project_indexed", [at.toISOString(), id]);
  }

  markProjectReconciled(id: ProjectId, at: Date = new Date()): void {
    this.write("mark_project_reconciled", [at.toISOString(), id]);
  }

  /**
   * Persist a "rebuild was requested for this project" marker so the
   * intent survives daemon restart. The startup reconciler reads
   * `listProjectsWithRebuildPending()` and reorders its queue so these
   * projects go first; the in-memory RebuildTracker is pre-populated so
   * the UI shows "resuming rebuild…" instead of a stale idle button.
   * Cleared by `clearProjectRebuildPending()` once the post-rebuild
   * indexProject pass succeeds.
   */
  markProjectRebuildPending(id: ProjectId, at: Date = new Date()): void {
    this.write("mark_project_rebuild_pending", [at.toISOString(), id]);
  }

  clearProjectRebuildPending(id: ProjectId): void {
    this.write("clear_project_rebuild_pending", [id]);
  }

  listProjectsWithRebuildPending(): ReadonlyArray<{
    readonly id: ProjectId;
    readonly name: string;
    readonly root: string;
    readonly rebuildPendingAt: string;
  }> {
    const rows = this.readAll<{
      id: string;
      name: string;
      root: string;
      rebuild_pending_at: string;
    }>("list_projects_with_rebuild_pending");
    return rows.map((r) => ({
      id: r.id as ProjectId,
      name: r.name,
      root: r.root,
      rebuildPendingAt: r.rebuild_pending_at,
    }));
  }

  /**
   * Flip the active flag for an existing project row. Returns true when
   * a row was updated, false when the project id didn't exist (caller
   * should upsert first if it wants to activate a brand-new project).
   */
  setProjectActive(id: ProjectId, active: boolean): boolean {
    const r = this.write("set_project_active", [active ? 1 : 0, id]);
    return r.changes > 0;
  }

  /**
   * Upsert a project and stamp its active state in one go. Used by
   * `loctx activate <path>` and the `/api/projects/activate` endpoint
   * — both want a newly-discovered project to materialise + activate
   * atomically.
   */
  upsertProjectWithActive(project: Project, active: boolean): void {
    this.write("upsert_project_active", [project.id, project.name, project.root, active ? 1 : 0]);
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

  /**
   * Purge a project's contents (chunks_fts, chunks, symbol_refs, files)
   * but keep the project row itself + its active/rebuild_pending_at
   * columns. Used by `/api/rebuild`: dropping the project row would
   * delete a persisted rebuild_pending_at marker that the next daemon
   * start needs to find. Also closes the "rebuild crash window" where
   * a daemon dying between deleteProject and indexProject leaves the
   * project stranded as "inactive" until manual re-activation.
   */
  purgeProjectContents(id: ProjectId): void {
    const tx = this.db.transaction(() => {
      this.write("delete_chunks_fts_for_project", [id]);
      this.write("delete_chunks_for_project", [id]);
      this.write("delete_symbol_refs_for_project", [id]);
      this.write("delete_files_for_project", [id]);
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
   * Per-project chunk counts. Used by the admin projects table — single
   * GROUP BY join instead of per-row queries, so the page stays cheap on
   * workspaces with many projects.
   */
  chunkCountsByProject(): Map<ProjectId, number> {
    const rows = this.readAll<{ project_id: string; n: number }>("count_chunks_by_project");
    return new Map(rows.map((r) => [r.project_id as ProjectId, Number(r.n)]));
  }

  /**
   * One row per successfully-indexed file (error IS NULL) with its chunk
   * count and indexed_at stamp. The admin /api/projects/:id route
   * aggregates byExtension, topFiles, and recentFiles from this single
   * pass in JS.
   */
  listIndexedFilesWithChunks(
    projectId: ProjectId,
  ): Array<{ relPath: string; indexedAt: string | null; chunks: number }> {
    const rows = this.readAll<{ rel_path: string; indexed_at: string | null; chunks: number }>(
      "list_indexed_files_with_chunks",
      [projectId],
    );
    return rows.map((r) => ({
      relPath: r.rel_path,
      indexedAt: r.indexed_at,
      chunks: Number(r.chunks),
    }));
  }

  /**
   * Count files committed for `projectId` at or after `since`. Used by
   * /api/projects to derive live rebuild progress from the files table
   * — the RebuildTracker isn't updated when the boot reconciler is the
   * one doing the rebuild work, so the tracker count is unreliable on
   * its own (#365).
   */
  countFilesIndexedSince(projectId: ProjectId, since: string): number {
    const row = this.readOne<{ n: number }>("count_files_indexed_since", [projectId, since]);
    return row === undefined ? 0 : Number(row.n);
  }

  /**
   * Files whose last index attempt errored (error IS NOT NULL). Listed
   * by /api/projects/:id so operators can see which files won't appear
   * in search until the underlying problem is fixed.
   */
  listFailingFiles(projectId: ProjectId): Array<{ relPath: string; error: string }> {
    const rows = this.readAll<{ rel_path: string; error: string }>("list_failing_files", [
      projectId,
    ]);
    return rows.map((r) => ({ relPath: r.rel_path, error: r.error }));
  }

  /**
   * Literal substring search over indexed chunk text. Distinct from
   * `searcher.search` (ranked / fused vector + lexical) and from
   * `findSymbol` (exact symbol cross-ref). This is the audit-shape
   * tool — every line in the indexed chunks that contains `pattern`,
   * with no ranking, no token splitting, no embedding. See #357.
   *
   * `pattern` is matched as a substring; the SQL LIKE wildcards `%`
   * and `_` and the escape `\` get pre-escaped so callers pass plain
   * text. Pass `regex` patterns through `findLiteralMatchesRegex`
   * (slower, JS-side filter); this path stays SQL-native for speed.
   *
   * Returns one row per matched line, not per chunk. A chunk that
   * contains the pattern on three different lines produces three
   * rows.
   */
  findLiteralMatches(
    pattern: string,
    opts: { readonly projectId?: ProjectId; readonly relPathPrefix?: string } = {},
  ): Array<LiteralMatch> {
    if (pattern.length === 0) return [];
    const escaped = escapeLikePattern(pattern);
    const rows = this.readAll<LiteralMatchRow>("find_literal_matches", [`%${escaped}%`]);
    const out: LiteralMatch[] = [];
    for (const r of rows) {
      if (opts.projectId !== undefined && r.project_id !== opts.projectId) continue;
      if (opts.relPathPrefix !== undefined && !r.rel_path.startsWith(opts.relPathPrefix)) continue;
      for (const m of extractLineMatches(r.document, pattern, r.start_line)) {
        out.push({
          projectId: r.project_id as ProjectId,
          projectName: r.project_name,
          relPath: r.rel_path,
          chunkId: r.chunk_id,
          chunkKind: r.kind,
          chunkStartLine: r.start_line,
          chunkEndLine: r.end_line,
          line: m.line,
          column: m.column,
          lineText: m.lineText,
        });
      }
    }
    return out;
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

  // ---- health probes --------------------------------------------------

  /**
   * Run a benign FTS5 MATCH + count against `chunks_fts` to confirm the
   * lexical search layer is actually usable. Called by `loctx doctor`
   * to distinguish "schema looks healthy" from "search will work" —
   * those can diverge if SQLite was rebuilt without FTS5 (some
   * embedded/musl builds drop it), or if a power-loss left the virtual
   * table corrupt. Returns the chunks_fts row count on success; throws
   * the underlying SQLite error verbatim on failure so doctor can
   * render an actionable message.
   */
  probeFts5(): { rows: number } {
    this.prepare("probe_fts5_match").get();
    const row = this.readOne<{ n: number }>("probe_fts5_count");
    return { rows: row?.n ?? 0 };
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

  // ---- MCP request log (#380-era) -------------------------------------

  /**
   * Append one MCP `tools/call` to the request log and trim the table
   * back to the newest `maxRows` entries, both in a single transaction.
   * `maxRows <= 0` is a no-op (logging disabled via `mcp.log_max_rows: 0`)
   * — callers that respect that knob shouldn't reach here, but guarding
   * keeps a misconfigured caller from inserting then immediately deleting
   * its own row. Best-effort by contract: callers wrap this so a logging
   * failure never affects the tool response.
   */
  logMcpRequest(entry: McpRequestLogInput, maxRows: number): void {
    if (maxRows <= 0) return;
    const requestedAt = entry.requestedAt ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.write("insert_mcp_request", [
        requestedAt,
        entry.tool,
        entry.argumentsJson,
        entry.responseJson,
        entry.error,
        entry.ok ? 1 : 0,
        entry.elapsedMs,
      ]);
      this.write("trim_mcp_requests", [maxRows]);
    });
    tx();
  }

  /** Newest-first MCP request rows, capped at `limit`. */
  listMcpRequests(limit: number): McpRequestLogEntry[] {
    return this.readAll<McpRequestRow>("list_mcp_requests", [Math.max(1, limit)]).map(
      mcpRequestEntryFromRow,
    );
  }

  countMcpRequests(): number {
    const row = this.readOne<{ n: number }>("count_mcp_requests");
    return row === undefined ? 0 : Number(row.n);
  }

  clearMcpRequests(): void {
    this.write("delete_all_mcp_requests");
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
        `Collection '${name}' is registered with identity '${existing}'; refusing to reuse with '${target}'. Run \`loctx reset index --force\` then \`loctx index\` to rebuild, or pick a different model.`,
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
  document: string;
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
    document: row.document,
  });
}

interface McpRequestRow {
  id: number;
  requested_at: string;
  tool: string;
  arguments_json: string;
  response_json: string | null;
  error: string | null;
  ok: number;
  elapsed_ms: number;
}

function mcpRequestEntryFromRow(row: McpRequestRow): McpRequestLogEntry {
  return Object.freeze({
    id: Number(row.id),
    requestedAt: row.requested_at,
    tool: row.tool,
    argumentsJson: row.arguments_json,
    responseJson: row.response_json,
    error: row.error,
    ok: row.ok !== 0,
    elapsedMs: Number(row.elapsed_ms),
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

// ---- find_literal helpers (#357) ----------------------------------------

interface LiteralMatchRow {
  readonly chunk_id: string;
  readonly file_id: string;
  readonly project_id: string;
  readonly rel_path: string;
  readonly document: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly kind: string;
  readonly project_name: string;
}

export interface LiteralMatch {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkId: string;
  readonly chunkKind: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
  /** Absolute file line (1-indexed) of the match. */
  readonly line: number;
  /** 1-indexed column of the first matching byte on that line. */
  readonly column: number;
  /** The full text of the matched line — useful for `eyeball if path is correct`. */
  readonly lineText: string;
}

/**
 * SQL LIKE treats `%`, `_`, `\` as special. We pre-escape them so the
 * caller passes plain literal text and gets substring semantics. The
 * SQL query is bound with `ESCAPE '\'` to honor the escape character.
 */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * For each occurrence of `pattern` in `document`, emit one match row
 * with the file-absolute line + column + full line text. The chunk's
 * `startLine` (1-indexed) anchors the offset → absolute-line
 * arithmetic.
 */
function extractLineMatches(
  document: string,
  pattern: string,
  chunkStartLine: number,
): Array<{ line: number; column: number; lineText: string }> {
  if (pattern.length === 0) return [];
  const out: Array<{ line: number; column: number; lineText: string }> = [];
  const lines = document.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const idx = line.indexOf(pattern);
    if (idx === -1) continue;
    out.push({
      line: chunkStartLine + i,
      column: idx + 1,
      lineText: line,
    });
  }
  return out;
}
