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
  fileId as toFileId,
  projectId as toProjectId,
} from "../models.js";
import { loadQueries } from "../sql/loader.js";
import type { UsageDelta, UsageStatRow } from "../usage.js";
import {
  type ChunkRow,
  chunkStateFromRow,
  escapeLikePattern,
  extractLineMatches,
  type FileRow,
  type FileStatsRow,
  fileStateFromRow,
  fileStatsFromRow,
  type LexicalRow,
  type LiteralMatch,
  type LiteralMatchRow,
  lexicalMatchFromRow,
  type McpRequestRow,
  mcpRequestEntryFromRow,
  type SymbolRefRow,
  symbolRefHitFromRow,
  type UsageStatDbRow,
} from "./state-rows.js";
import type {
  ChunkInsert,
  ChunkState,
  DuplicateGroup,
  DuplicateMember,
  FileEnrichmentRow,
  FileState,
  LexicalMatch,
  LexicalQuery,
  McpRequestLogEntry,
  McpRequestLogInput,
  ProjectFileStats,
  SymbolRefHit,
} from "./state-types.js";

export const SCHEMA_VERSION = 10;

/**
 * Raised when the on-disk schema version is newer than this build's
 * `SCHEMA_VERSION` — i.e. the user downgraded loctx. We refuse to open
 * the DB rather than blindly write through it, because newer schemas
 * may have columns this build doesn't know to populate.
 */
export class SchemaTooNewError extends Error {}

const QUERIES = loadQueries("../sql/state.sql", import.meta.url);

/**
 * One rung of the schema ladder. Applied in order by
 * {@link StateStore.migrate}; each section lives in `sql/state.sql`
 * (CORE-2 — the ladder used to be ten hand-written if-blocks with the
 * v3 CREATE TABLE SQL inlined in TypeScript).
 */
interface Migration {
  readonly version: number;
  /** Named section in state.sql to exec. */
  readonly section: string;
  /**
   * Columns this migration ALTER-adds. When all of them already exist
   * (user_version walked backwards — see #196), the section is skipped
   * and `alreadyAppliedSection` (if any) runs instead.
   */
  readonly addsColumns?: ReadonlyArray<{ readonly table: string; readonly column: string }>;
  /** Idempotent (IF NOT EXISTS) subset to run when the ALTERs already applied. */
  readonly alreadyAppliedSection?: string;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, section: "schema_v1" },
  // BM25 / FTS5 lexical index over chunks.
  { version: 2, section: "schema_v2" },
  // Analyzer metadata + symbol cross-reference graph (#58). ALTERs
  // chunks and CREATEs symbol_refs; when the columns already exist the
  // IF NOT EXISTS CREATEs still need to run — schema_v3_tables is that
  // subset.
  {
    version: 3,
    section: "schema_v3",
    addsColumns: [
      { table: "chunks", column: "metadata_json" },
      { table: "chunks", column: "symbol_def" },
    ],
    alreadyAppliedSection: "schema_v3_tables",
  },
  // Reconciliation tracking (#14).
  {
    version: 4,
    section: "schema_v4",
    addsColumns: [{ table: "projects", column: "last_reconciled_at" }],
  },
  // Background analyzer enrichments (#61).
  { version: 5, section: "schema_v5" },
  // Project activation.
  { version: 6, section: "schema_v6", addsColumns: [{ table: "projects", column: "active" }] },
  // Rebuild-pending flag (#299).
  {
    version: 7,
    section: "schema_v7",
    addsColumns: [{ table: "projects", column: "rebuild_pending_at" }],
  },
  // mcp_requests log table + index (IF NOT EXISTS, safe to re-run).
  { version: 8, section: "schema_v8" },
  // file_links doc cross-link graph (#427; IF NOT EXISTS, safe to re-run).
  { version: 9, section: "schema_v9" },
  // usage_stats value-served accounting (IF NOT EXISTS, safe to re-run).
  { version: 10, section: "schema_v10" },
];

export class CollectionIdentityMismatch extends Error {}

const MCP_LOG_FIELD_MAX = 256 * 1024; // 256 KB per field

function capLogField(value: string | null): string | null {
  if (value === null || value.length <= MCP_LOG_FIELD_MAX) return value;
  return `${value.slice(0, MCP_LOG_FIELD_MAX)}\n…[truncated ${value.length - MCP_LOG_FIELD_MAX} chars]`;
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

    for (const m of MIGRATIONS) {
      if (current >= m.version) continue;
      const sql = QUERIES[m.section];
      if (sql === undefined) throw new Error(`Missing ${m.section} in state.sql`);
      // SQLite has no `ADD COLUMN IF NOT EXISTS`, and a column may
      // already exist when the DB was opened by a newer build then
      // walked back via PRAGMA user_version (test-suite scenario, plus
      // possible downgrade). Migrations that ALTER-add columns declare
      // them in `addsColumns`; when every declared column is present we
      // skip the section (running the optional `alreadyAppliedSection`
      // instead — v3 still needs its IF NOT EXISTS CREATEs). See #196.
      const alreadyApplied =
        m.addsColumns?.every((c) => this.columnExists(c.table, c.column)) ?? false;
      if (!alreadyApplied) {
        this.db.exec(sql);
        continue;
      }
      if (m.alreadyAppliedSection !== undefined) {
        const fallback = QUERIES[m.alreadyAppliedSection];
        if (fallback === undefined) {
          throw new Error(`Missing ${m.alreadyAppliedSection} in state.sql`);
        }
        this.db.exec(fallback);
      }
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
      id: toProjectId(r.id),
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
      this.write("delete_file_links_for_project", [id]);
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
      this.write("delete_file_links_for_project", [id]);
      this.write("delete_files_for_project", [id]);
    });
    tx();
  }

  // ---- doc cross-link graph (#427) ------------------------------------

  /**
   * Replace the outbound markdown links recorded for a file. Called on each
   * (re-)index of a markdown file; one transaction so a file is never left
   * with a partial link set. Targets are absolute resolved paths.
   */
  replaceFileLinks(
    fileId: string,
    links: ReadonlyArray<{ readonly toPath: string; readonly text: string }>,
  ): void {
    const tx = this.db.transaction(() => {
      this.write("delete_file_links_for_file", [fileId]);
      for (const l of links) this.write("insert_file_link", [fileId, l.toPath, l.text]);
    });
    tx();
  }

  /** Inbound-link count for an absolute path — distinct files that link to it. */
  inboundCount(absPath: string): number {
    const row = this.readOne<{ n: number }>("inbound_count_for_path", [absPath]);
    return row?.n ?? 0;
  }

  /**
   * Batched {@link inboundCount}: distinct inbound-link counts for many
   * paths in one `GROUP BY` query instead of one round-trip per file
   * (#446). The ranking loop over the over-fetched candidate set (~100
   * chunks) was issuing a query per unique file; this collapses it to a
   * single prepared statement. Paths absent from the result linked
   * nowhere — callers default those to 0. Dynamic IN placeholder count,
   * same shape as {@link getAnalyzersByChunkIds}.
   */
  inboundCounts(absPaths: ReadonlyArray<string>): Map<string, number> {
    const out = new Map<string, number>();
    const unique = [...new Set(absPaths)];
    if (unique.length === 0) return out;
    const placeholders = unique.map(() => "?").join(",");
    const sql = `SELECT to_path, COUNT(DISTINCT from_file_id) AS n
                 FROM file_links WHERE to_path IN (${placeholders}) GROUP BY to_path`;
    const rows = this.db.prepare(sql).all(...unique) as Array<{ to_path: string; n: number }>;
    for (const r of rows) out.set(r.to_path, Number(r.n));
    return out;
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
   * Files in a project lacking an up-to-date `complete` enrichment for the
   * given analyzer (matched on the file's current content_sha). Powers the
   * analyzer backfill: when a feature is enabled after the index is built,
   * we re-run only this analyzer over just these files — no re-embedding.
   */
  listFilesMissingEnrichment(
    projectId: ProjectId,
    analyzer: string,
    analyzerVersion: number,
  ): Array<{ readonly fileId: FileId; readonly relPath: string; readonly contentSha: string }> {
    const rows = this.readAll<{ file_id: string; rel_path: string; content_sha: string }>(
      "list_files_missing_enrichment",
      [projectId, analyzer, analyzerVersion],
    );
    return rows.map((r) => ({
      fileId: toFileId(r.file_id),
      relPath: r.rel_path,
      contentSha: r.content_sha,
    }));
  }

  /**
   * Per-project chunk counts. Used by the admin projects table — single
   * GROUP BY join instead of per-row queries, so the page stays cheap on
   * workspaces with many projects.
   */
  chunkCountsByProject(): Map<ProjectId, number> {
    const rows = this.readAll<{ project_id: string; n: number }>("count_chunks_by_project");
    return new Map(rows.map((r) => [toProjectId(r.project_id), Number(r.n)]));
  }

  /**
   * Per-project file stats in one GROUP BY: file count, error count,
   * newest indexed_at. Replaces the `listFiles().filter().length`
   * pattern that pulled every file row per project just to derive
   * three scalars — the /api/projects endpoint is polled every 3-8s,
   * so that N+1 scaled with projects × files (#455). Same shape as
   * {@link chunkCountsByProject}.
   */
  fileStatsByProject(): Map<ProjectId, ProjectFileStats> {
    const rows = this.readAll<FileStatsRow>("file_stats_by_project");
    return new Map(rows.map((r) => [toProjectId(r.project_id), fileStatsFromRow(r)]));
  }

  /** Single-project variant of {@link fileStatsByProject} for detail views. */
  fileStatsForProject(projectId: ProjectId): ProjectFileStats {
    const row = this.readOne<FileStatsRow>("file_stats_for_project", [projectId]);
    return row === undefined || row.files === 0
      ? { files: 0, errors: 0, lastIndexed: null }
      : fileStatsFromRow(row);
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
    const like = `%${escapeLikePattern(pattern)}%`;
    // Push project / subtree scope into SQL (#446) instead of loading
    // every project's matches and dropping the wrong ones host-side.
    let rows: LiteralMatchRow[];
    if (opts.projectId !== undefined && opts.relPathPrefix !== undefined) {
      const prefixLike = `${escapeLikePattern(opts.relPathPrefix)}%`;
      rows = this.readAll<LiteralMatchRow>("find_literal_matches_subtree", [
        like,
        opts.projectId,
        prefixLike,
      ]);
    } else if (opts.projectId !== undefined) {
      rows = this.readAll<LiteralMatchRow>("find_literal_matches_project", [like, opts.projectId]);
    } else {
      rows = this.readAll<LiteralMatchRow>("find_literal_matches", [like]);
    }
    const out: LiteralMatch[] = [];
    for (const r of rows) {
      // Defensive: a relPathPrefix without a projectId can't use the
      // subtree query (which is project-scoped); fall back to a host-side
      // prefix check for that (contract-violating) case only.
      if (
        opts.projectId === undefined &&
        opts.relPathPrefix !== undefined &&
        !r.rel_path.startsWith(opts.relPathPrefix)
      ) {
        continue;
      }
      for (const m of extractLineMatches(r.document, pattern, r.start_line)) {
        out.push({
          projectId: toProjectId(r.project_id),
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

  /**
   * One file's chunk ranges with parsed AST metadata, in file order.
   * Feeds the quality analyzer's reader port (#522); chunks indexed
   * before v3 carry null metadata and the rules skip them. Shares the
   * `list_chunks` statement with {@link listChunks} — different
   * projection, same rows.
   */
  listChunksWithMetadata(
    fileId: FileId,
  ): Array<{ startLine: number; endLine: number; metadata: AnalyzerMetadata | null }> {
    const rows = this.readAll<{
      start_line: number;
      end_line: number;
      metadata_json: string | null;
    }>("list_chunks", [fileId]);
    return rows.map((r) => ({
      startLine: r.start_line,
      endLine: r.end_line,
      metadata: analyzerMetadataFromJson(r.metadata_json),
    }));
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
  /**
   * Cross-file duplicate groups, hash-grouped in SQL (json_each over the
   * windows) so we never materialise every token-window in JS — the old
   * load-all-payloads-and-Map approach OOM-aborted the MCP process on a
   * workspace with a large project. `projectId` scopes to one project;
   * null spans the whole workspace. Output is capped (top groups by member
   * count, members per group) so a heavily-duplicated workspace can't
   * produce an unbounded response.
   */
  findDuplicateGroups(minMembers = 2, projectId: string | null = null): DuplicateGroup[] {
    const MAX_GROUPS = 200;
    const MAX_MEMBERS_PER_GROUP = 50;
    const min = Math.max(2, minMembers);
    const rows =
      projectId === null
        ? this.readAll<{ hash: string; file_id: string; start_line: number; end_line: number }>(
            "find_duplicate_groups_all",
            [min],
          )
        : this.readAll<{ hash: string; file_id: string; start_line: number; end_line: number }>(
            "find_duplicate_groups_in_project",
            [projectId, min],
          );

    // Rows arrive ordered by hash; group contiguously, capping members so
    // one pathological group can't dominate memory or the response.
    const byHash = new Map<string, DuplicateMember[]>();
    for (const row of rows) {
      const list = byHash.get(row.hash) ?? [];
      if (list.length < MAX_MEMBERS_PER_GROUP) {
        list.push({
          fileId: toFileId(row.file_id),
          startLine: row.start_line,
          endLine: row.end_line,
        });
      }
      byHash.set(row.hash, list);
    }
    const groups: DuplicateGroup[] = [];
    for (const [hash, members] of byHash.entries()) {
      groups.push({ hash, members: Object.freeze(members) });
    }
    return groups.sort((a, b) => b.members.length - a.members.length).slice(0, MAX_GROUPS);
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

  /**
   * Drop one (file, analyzer) enrichment row (#547). Backfill calls
   * this when the analyzer's buildTask now SKIPS the file, so stale
   * rows from before a skip rule can't feed query-time aggregations.
   */
  deleteFileEnrichment(fileId: FileId, analyzer: string): void {
    this.write("delete_file_enrichment", [fileId, analyzer]);
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

  /**
   * Path-suffix lookup for docs-shorthand references (quality/stale-ref):
   * the indexed relPath that this ref resolves to, or null. Exact match
   * beats suffix; shortest suffix match wins.
   */
  resolveFileSuffix(projectId: ProjectId, refPath: string): string | null {
    const escaped = refPath.replace(/[\\%_]/g, (m) => `\\${m}`);
    const row = this.readOne<{ rel_path: string }>("resolve_file_suffix", [
      projectId,
      refPath,
      escaped,
    ]);
    return row === undefined ? null : row.rel_path;
  }

  /**
   * Complete `quality` payloads for one project (#525). One join; the
   * report parses payload JSON in JS with per-row error isolation.
   */
  listQualityEnrichments(
    projectId: ProjectId,
  ): Array<{ readonly fileId: string; readonly payloadJson: string }> {
    const rows = this.readAll<{ file_id: string; payload_json: string }>(
      "list_quality_enrichments_for_project",
      [projectId],
    );
    return rows.map((r) => ({ fileId: r.file_id, payloadJson: r.payload_json }));
  }

  /**
   * Live inbound-reference counts per defining file (#525,
   * `quality/high-fan-in`). One batch GROUP BY per report call instead
   * of a query per file.
   */
  fanInCounts(projectId: ProjectId): Map<string, number> {
    const rows = this.readAll<{ file_id: string; n: number }>("fan_in_counts_for_project", [
      projectId,
    ]);
    return new Map(rows.map((r) => [r.file_id, Number(r.n)]));
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
        capLogField(entry.argumentsJson),
        capLogField(entry.responseJson),
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

  // ---- value-served accounting (#value-metrics) -----------------------

  /**
   * Accumulate the value of one retrieval query into `usage_stats`. Each
   * delta is added to its project's running totals (`""` = workspace
   * roll-up). Best-effort and cheap; called off the hot path.
   */
  applyUsageDeltas(deltas: ReadonlyArray<UsageDelta>): void {
    if (deltas.length === 0) return;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const d of deltas) {
        this.write("upsert_usage", [
          d.projectId,
          d.queries,
          d.resultsBytes,
          d.baselineBytes,
          d.filesReadAvoided,
          d.zeroHitQueries,
          d.elapsedMs,
          now,
        ]);
      }
    });
    tx();
  }

  /** All accumulated usage rows (the `""` roll-up plus one per project). */
  readUsageStats(): UsageStatRow[] {
    return this.readAll<UsageStatDbRow>("list_usage_stats").map((r) => ({
      projectId: r.project_id,
      queries: Number(r.queries),
      resultsBytes: Number(r.results_bytes),
      baselineBytes: Number(r.baseline_bytes),
      filesReadAvoided: Number(r.files_read_avoided),
      zeroHitQueries: Number(r.zero_hit_queries),
      elapsedMs: Number(r.elapsed_ms),
    }));
  }

  clearUsageStats(): void {
    this.write("delete_all_usage_stats");
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

  /**
   * Every Lance collection this state DB has ever registered. Lets
   * maintenance paths (`purge` without a daemon) reach vector rows in
   * ALL tables — including ones written under a previous embedding
   * model — without loading a model to derive the current identity.
   */
  listCollections(): string[] {
    return this.readAll<{ name: string }>("list_collections").map((r) => r.name);
  }
}

export type { LiteralMatch } from "./state-rows.js";
// Re-exports (#542 split): existing importers keep working through
// state.ts.
export * from "./state-types.js";
