/**
 * Public row/query shapes of the state store (#542 split from
 * state.ts). Pure types — no db access.
 */

import type { AnalyzerMetadata, FileId, ProjectId, SymbolRef, SymbolRefKind } from "../models.js";

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

/** Aggregated file stats for one project. See {@link StateStore.fileStatsByProject}. */
export interface ProjectFileStats {
  readonly files: number;
  readonly errors: number;
  /** Newest `indexed_at` across the project's files (ISO-8601), null when empty. */
  readonly lastIndexed: string | null;
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

/**
 * The mcp_requests log stores each call's payload verbatim for debugging,
 * but an unbounded response (e.g. a large find_duplicates result) can reach
 * tens of MB. Serializing the whole table for the Logs page then overflows
 * JSON.stringify (RangeError: Invalid string length). Cap each stored field
 * so one big call can't wedge the log or bloat the DB.
 */
