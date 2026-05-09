/**
 * Shared types used across loctx modules.
 */

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type FileId = string & { readonly __brand: "FileId" };
export type ChunkId = string & { readonly __brand: "ChunkId" };

export const projectId = (raw: string): ProjectId => raw as ProjectId;
export const fileId = (raw: string): FileId => raw as FileId;
export const chunkId = (raw: string): ChunkId => raw as ChunkId;

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly root: string;
}

export interface EmbeddingIdentity {
  readonly provider: string;
  readonly model: string;
  readonly dimension: number;
  readonly normalize: boolean;
}

/** Filesystem-safe slug derived from an identity, used as the vector table name suffix. */
export function collectionSuffix(identity: EmbeddingIdentity): string {
  const provider = identity.provider.replaceAll("/", "-");
  const model = identity.model.replaceAll("/", "-");
  const norm = identity.normalize ? "n1" : "n0";
  return `${provider}__${model}__d${identity.dimension}__${norm}`;
}

export function identityToString(identity: EmbeddingIdentity): string {
  const norm = identity.normalize ? "1" : "0";
  return `${identity.provider}|${identity.model}|d=${identity.dimension}|n=${norm}`;
}

// ---- analyzer metadata -------------------------------------------------

/**
 * Cheap AST-derived metadata attached to a chunk. Extracted during
 * indexing (#59) by walking the same tree-sitter parse the chunker
 * already runs — no extra scan time. Stored as JSON in
 * `chunks.metadata_json`; flat scalars surface in retrieval ranking
 * (#60). Optional on every consumer; chunks indexed before v3 carry
 * `null` and surface as 'pending re-extraction' in `loctx doctor`.
 */
export interface AnalyzerMetadata {
  /** Modules / paths this chunk imports from. */
  readonly imports: ReadonlyArray<string>;
  /** Names exported by this chunk (functions, classes, vars). */
  readonly exports: ReadonlyArray<string>;
  /** Identifiers this chunk calls or references. */
  readonly calls: ReadonlyArray<string>;
  /** Maximum nesting depth (blocks, functions, classes). */
  readonly maxNestingDepth: number;
  /** Maximum loop depth (for/while). */
  readonly maxLoopDepth: number;
  /** Parameter count for the primary function/method, 0 if not applicable. */
  readonly paramCount: number;
  /** Chunk uses `async` somewhere. */
  readonly hasAsync: boolean;
  /** Chunk recursively calls its own defining symbol. */
  readonly hasRecursionHint: boolean;
  /**
   * Risky-call categories matched in this chunk
   * (`eval`, `exec`, `system`, `child_process`, `dangerouslySetInnerHTML`, ...).
   */
  readonly riskyCalls: ReadonlyArray<string>;
  /** Tooling source (e.g. `"tree-sitter"`). */
  readonly analysisSource: string;
  /** Bumped when the extractor changes; used to trigger re-extraction. */
  readonly analysisVersion: number;
}

/** Serialize to the JSON form stored in chunks.metadata_json. */
export function analyzerMetadataToJson(meta: AnalyzerMetadata): string {
  return JSON.stringify(meta);
}

/**
 * Parse an analyzer JSON blob from chunks.metadata_json. Returns null on
 * any parse error or missing required field — callers treat null the
 * same as 'pending re-extraction' on a v2-era chunk.
 */
export function analyzerMetadataFromJson(raw: string | null): AnalyzerMetadata | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyzerMetadata>;
    if (typeof parsed.analysisSource !== "string" || typeof parsed.analysisVersion !== "number") {
      return null;
    }
    return Object.freeze({
      imports: Object.freeze(parsed.imports ?? []),
      exports: Object.freeze(parsed.exports ?? []),
      calls: Object.freeze(parsed.calls ?? []),
      maxNestingDepth: parsed.maxNestingDepth ?? 0,
      maxLoopDepth: parsed.maxLoopDepth ?? 0,
      paramCount: parsed.paramCount ?? 0,
      hasAsync: parsed.hasAsync ?? false,
      hasRecursionHint: parsed.hasRecursionHint ?? false,
      riskyCalls: Object.freeze(parsed.riskyCalls ?? []),
      analysisSource: parsed.analysisSource,
      analysisVersion: parsed.analysisVersion,
    });
  } catch {
    return null;
  }
}

/**
 * A single row of the symbol cross-reference graph. Populated during
 * indexing (#96) and queried via `StateStore.findSymbol` to power the
 * forthcoming `find_usages` MCP tool.
 */
export interface SymbolRef {
  readonly symbol: string;
  readonly projectId: ProjectId;
  readonly fileId: FileId;
  readonly chunkId: ChunkId;
  readonly line: number;
  readonly kind: SymbolRefKind;
}

export type SymbolRefKind = "def" | "call" | "import" | "reference";
