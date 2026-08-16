/**
 * duplicates contracts (split from the 687-line contracts.ts, #542).
 */

// ---- duplicates inspector (#523 surfacing) ------------------------------

export interface DuplicateMemberRow {
  readonly fileId: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface DuplicateGroupRow {
  readonly hash: string;
  readonly members: ReadonlyArray<DuplicateMemberRow>;
}

export interface SemanticGroupRow {
  readonly similarity: number;
  readonly files: number;
  readonly members: ReadonlyArray<{
    readonly fileId: string;
    readonly relPath: string;
    readonly startLine: number;
    readonly endLine: number;
  }>;
}

export interface DuplicatesPayload {
  readonly projectId: string;
  readonly projectName: string;
  readonly groups: ReadonlyArray<DuplicateGroupRow>;
  readonly semantic: {
    readonly groups: ReadonlyArray<SemanticGroupRow>;
    readonly scanned: number;
    readonly truncated: boolean;
  } | null;
  /** Non-null when the semantic pass didn't run — says why. */
  readonly semanticDisabled: string | null;
  /** Non-null when the exact-match analyzer is off — says why. */
  readonly disabled: string | null;
  readonly warnings: ReadonlyArray<string>;
}
