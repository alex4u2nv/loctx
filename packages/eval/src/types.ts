/**
 * Shared types for the eval harness.
 *
 * Branding `QueryId` and `RunId` keeps qrels-loader output and runner
 * output from getting confused with arbitrary strings at the function
 * boundary — both flow through metric reducers that key on them.
 */

export type QueryId = string & { readonly __brand: "QueryId" };
export type RunId = string & { readonly __brand: "RunId" };

export const queryId = (raw: string): QueryId => raw as QueryId;
export const runId = (raw: string): RunId => raw as RunId;

/**
 * Relevance grade. Matches the schema in golden/v1/qrels.jsonl.
 *   0 = not relevant (never written as a row; absence == 0)
 *   1 = partial — useful context but not the answer
 *   2 = canonical — the chunk an expert would point at
 */
export type Relevance = 0 | 1 | 2;

export type QueryType = "literal" | "symbol" | "concept" | "mixed" | "prose";

export interface Qrel {
  readonly queryId: QueryId;
  readonly query: string;
  readonly queryType: QueryType;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly relevance: Relevance;
  readonly notes?: string;
  /**
   * Who authored this row. v1 is autonomous-built and needs a human
   * audit pass before any reranker/repo-map gating decisions use it.
   * See golden/v1/README.md.
   */
  readonly provenance: string;
}

/**
 * One retrieved document in a single query's ranked result list. The
 * docid format is `relPath:startLine-endLine`; matching against qrels
 * is span-overlap, not exact docid equality.
 */
export interface RankedDoc {
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  /** 1-based rank within the per-query result list. */
  readonly rank: number;
}

export interface QueryRunResult {
  readonly queryId: QueryId;
  readonly query: string;
  readonly queryType: QueryType;
  readonly ranked: ReadonlyArray<RankedDoc>;
}

/**
 * The six headline metrics the report surfaces. Each value is in [0, 1].
 * Per-query metrics use the same keys.
 */
export interface MetricSummary {
  readonly hitAt1: number;
  readonly hitAt3: number;
  readonly hitAt10: number;
  readonly mrrAt10: number;
  readonly ndcgAt10: number;
  readonly recallAt20: number;
  readonly recallAt50: number;
}

export interface PerQueryMetrics extends MetricSummary {
  readonly queryId: QueryId;
  readonly queryType: QueryType;
}

export interface RunResultJson {
  readonly runId: string;
  readonly goldenSet: string;
  readonly corpusSha: string;
  readonly loctxSha: string;
  readonly embedder: string;
  readonly runtime: string;
  readonly chunkingConfig: string;
  readonly retrievalConfig: string;
  /** Hash of the chunk-boundary set, used for cross-run determinism checks. */
  readonly chunkBoundaryHash: string;
  readonly metrics: {
    readonly overall: MetricSummary;
    readonly byQueryType: Readonly<Record<string, MetricSummary>>;
  };
  readonly perQuery: ReadonlyArray<PerQueryMetrics>;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface CorpusConfig {
  readonly name: string;
  readonly repo: string;
  readonly sha: string;
  readonly indexConfig: string;
}
