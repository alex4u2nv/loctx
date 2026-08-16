/**
 * search contracts (split from the 687-line contracts.ts, #542).
 */

import type { SearchResult } from "@loctx/core";
import type { IndexHealth } from "@loctx/mcp";

export interface SearchRequestBody {
  readonly query: string;
  readonly path?: string;
  readonly limit?: number;
  readonly language?: string;
  readonly coverage?: boolean;
}

/**
 * One search result on the wire — the core searcher's result minus the
 * fields the admin UI doesn't consume (SRV-10). Derived rather than
 * re-declared so a new core field can't silently drift out of the HTTP
 * response's type:
 *
 *   - `projectRoot` / `analyzer` are dropped: the UI renders relPath +
 *     absPath and never reads the raw AST metadata blob.
 *   - `enrichments.lizard` drops the function's own lineFrom/lineTo
 *     (the chunk's startLine/endLine are what the UI links to).
 */
export type SearchHit = Omit<SearchResult, "projectRoot" | "analyzer" | "enrichments"> & {
  readonly enrichments: {
    readonly lizard: Omit<
      NonNullable<SearchResult["enrichments"]["lizard"]>,
      "lineFrom" | "lineTo"
    > | null;
    readonly findings: SearchResult["enrichments"]["findings"];
  };
};

export interface SearchPayload {
  readonly resolvedScope: {
    readonly mode: "all" | "project" | "subtree";
    readonly project: { readonly id: string; readonly name: string } | null;
    readonly relPrefix: string | null;
  };
  readonly results: ReadonlyArray<SearchHit>;
  readonly warnings: ReadonlyArray<string>;
  /**
   * Same liveness signal the MCP tools carry (#43): search results may
   * be partial while the daemon is mid-reconcile. Optional/additive
   * (SRV-10) so existing typed consumers compile unchanged; the HTTP
   * daemon observes its own reconciler, so `reconciling` is always a
   * plain boolean here (never "unknown").
   */
  readonly indexHealth?: IndexHealth;
}

export interface FindUsagesRequest {
  readonly symbol: string;
  readonly path?: string;
}

export interface FindUsagesPayload {
  readonly symbol: string;
  readonly defs: ReadonlyArray<UsageHit>;
  readonly refs: ReadonlyArray<UsageHit>;
  /**
   * Surface-level warnings the daemon attaches to the response — mainly
   * the "index is reconciling, hits may be partial" signal (#44) so the
   * UI can warn before the user assumes the symbol is undefined.
   */
  readonly warnings: ReadonlyArray<string>;
}

export interface UsageHit {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
  readonly kind: string;
  /** Chunk body the symbol appeared in. Powers the snippet modal. */
  readonly snippet: string;
}

// ---- find_literal (#357) ----------------------------------------------

export interface FindLiteralPayload {
  readonly pattern: string;
  readonly matches: ReadonlyArray<LiteralHit>;
  /** Distinct files containing at least one match. */
  readonly fileCount: number;
  /**
   * Always populated — reminds callers that the scan covers indexed
   * chunk text. Lines outside any chunk (chunker gaps — see #360)
   * are not searched. For total file coverage, supplement with `rg`.
   */
  readonly coverageNote: string;
  /** Same warnings stream other read endpoints use (reconcile, etc.). */
  readonly warnings: ReadonlyArray<string>;
}

export interface LiteralHit {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkKind: string;
  readonly chunkStartLine: number;
  readonly chunkEndLine: number;
  /** Absolute file line (1-indexed). */
  readonly line: number;
  /** 1-indexed column of the first matching byte on that line. */
  readonly column: number;
  /** Full text of the matched line. */
  readonly lineText: string;
}
