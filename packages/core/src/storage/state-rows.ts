/**
 * Row -> domain mapping helpers and the find_literal scan helpers
 * (#542 split from state.ts). Consumed only by StateStore.
 */

import {
  type ProjectId,
  type SymbolRefKind,
  chunkId as toChunkId,
  fileId as toFileId,
  projectId as toProjectId,
} from "../models.js";
import type {
  ChunkState,
  FileState,
  LexicalMatch,
  McpRequestLogEntry,
  ProjectFileStats,
  SymbolRefHit,
} from "./state-types.js";

// ---- row mappings -------------------------------------------------------

export interface FileStatsRow {
  project_id: string;
  files: number;
  errors: number;
  last_indexed: string | null;
}

export function fileStatsFromRow(r: FileStatsRow): ProjectFileStats {
  return {
    files: Number(r.files),
    errors: Number(r.errors),
    lastIndexed: r.last_indexed,
  };
}

export interface FileRow {
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

export interface ChunkRow {
  chunk_id: string;
  file_id: string;
  start_line: number;
  end_line: number;
  kind: string;
  symbols: string | null;
}

export interface LexicalRow {
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

export interface SymbolRefRow {
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

export function symbolRefHitFromRow(row: SymbolRefRow): SymbolRefHit {
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

export interface McpRequestRow {
  id: number;
  requested_at: string;
  tool: string;
  arguments_json: string;
  response_json: string | null;
  error: string | null;
  ok: number;
  elapsed_ms: number;
}

export interface UsageStatDbRow {
  project_id: string;
  queries: number;
  results_bytes: number;
  baseline_bytes: number;
  files_read_avoided: number;
  zero_hit_queries: number;
  elapsed_ms: number;
}

export function mcpRequestEntryFromRow(row: McpRequestRow): McpRequestLogEntry {
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

export function lexicalMatchFromRow(row: LexicalRow): LexicalMatch {
  return {
    chunkId: row.chunk_id,
    fileId: toFileId(row.file_id),
    projectId: toProjectId(row.project_id),
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

export function fileStateFromRow(row: FileRow): FileState {
  return {
    fileId: toFileId(row.file_id),
    projectId: toProjectId(row.project_id),
    relPath: row.rel_path,
    size: row.size,
    mtime: row.mtime,
    contentSha: row.content_sha,
    indexedAt: row.indexed_at,
    embeddingIdentity: row.embedding_identity,
    error: row.error,
  };
}

export function chunkStateFromRow(row: ChunkRow): ChunkState {
  return {
    chunkId: row.chunk_id,
    fileId: toFileId(row.file_id),
    startLine: row.start_line,
    endLine: row.end_line,
    kind: row.kind,
    symbols: row.symbols ? Object.freeze(row.symbols.split(",")) : Object.freeze([]),
  };
}

// ---- find_literal helpers (#357) ----------------------------------------

export interface LiteralMatchRow {
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
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * For each occurrence of `pattern` in `document`, emit one match row
 * with the file-absolute line + column + full line text. The chunk's
 * `startLine` (1-indexed) anchors the offset → absolute-line
 * arithmetic.
 */
export function extractLineMatches(
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
