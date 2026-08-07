/**
 * Retrieval metrics: Hit@k, MRR@k, nDCG@k, Recall@k.
 *
 * All pure functions over `(rankedRelevances, qrels)`. The matching
 * step (span overlap → relevance grade) lives in `qrels.ts`; this
 * module only knows about the per-rank relevance array and the qrel
 * set for the query, so the same formulas can be re-driven later
 * with LLM-judged or human-judged grades without code changes.
 *
 * Binarization rule: Hit/MRR/Recall treat relevance >= 1 as a hit.
 * nDCG uses graded relevance with gain = 2^rel - 1 (exponential gain
 * is the standard formulation; matches what `pytrec_eval` defaults to).
 */

import { groupQrelsByQuery, judgeRanked, qrelMatchesDoc } from "./qrels.js";
import type {
  MetricSummary,
  PerQueryMetrics,
  Qrel,
  QueryType,
  RankedDoc,
  Relevance,
} from "./types.js";

/** Top-k cutoffs reported on every run. Update the report header if these move. */
export const K_HITS: ReadonlyArray<number> = Object.freeze([1, 3, 10]);
export const K_MRR = 10;
export const K_NDCG = 10;
export const K_RECALL: ReadonlyArray<number> = Object.freeze([20, 50]);

export function hitAtK(ranked: ReadonlyArray<Relevance>, k: number): number {
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    const r = ranked[i];
    if (r !== undefined && r >= 1) return 1;
  }
  return 0;
}

export function rrAtK(ranked: ReadonlyArray<Relevance>, k: number): number {
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    const r = ranked[i];
    if (r !== undefined && r >= 1) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Recall@k for a single query. Denominator is the count of relevant
 * qrels (relevance >= 1). Numerator is the count of *distinct* relevant
 * qrels covered by any ranked doc in top-k — overlapping a single qrel
 * span with three different chunks still counts as one. Returns 0 when
 * the query has no relevant qrels (guards against NaN).
 */
export function recallAtK(
  rankedDocs: ReadonlyArray<RankedDoc>,
  qrels: ReadonlyArray<Qrel>,
  k: number,
): number {
  const relevantQrels = qrels.filter((q) => q.relevance >= 1);
  if (relevantQrels.length === 0) return 0;
  const covered = new Set<number>();
  const topK = rankedDocs.slice(0, k);
  for (const doc of topK) {
    for (const [qi, q] of relevantQrels.entries()) {
      if (covered.has(qi)) continue;
      if (qrelMatchesDoc(q, doc)) covered.add(qi);
    }
  }
  return covered.size / relevantQrels.length;
}

/**
 * nDCG@k with exponential gain. DCG = sum(gain / log2(rank+1)), IDCG
 * is the same sum against a perfect ranking of the query's qrels.
 * Returns 0 when there are no relevant qrels (IDCG would be 0).
 *
 * Each qrel only counts once toward the ideal — the relevance bag is
 * a multiset of grades, descending. Each ranked doc only counts once
 * toward the actual DCG — second/third chunks overlapping the same
 * qrel don't double-credit. This matches `pytrec_eval --measures
 * ndcg_cut.10` against the same qrels format.
 */
export function ndcgAtK(
  rankedDocs: ReadonlyArray<RankedDoc>,
  qrels: ReadonlyArray<Qrel>,
  k: number,
): number {
  const relevantQrels = qrels.filter((q) => q.relevance >= 1);
  if (relevantQrels.length === 0) return 0;
  const idealGrades: number[] = relevantQrels
    .map((q) => q.relevance)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idcg = idealGrades.reduce<number>((acc, g, i) => acc + gain(g) / discount(i + 1), 0);
  if (idcg === 0) return 0;

  // Walk ranked docs, take the highest-grade still-unconsumed qrel
  // that each one overlaps. "Unconsumed" prevents one matched chunk
  // crediting the same qrel twice when a later chunk also overlaps it.
  const consumed = new Set<number>();
  let dcg = 0;
  const topK = rankedDocs.slice(0, k);
  for (const [r, doc] of topK.entries()) {
    const best = bestUnconsumedMatch(doc, relevantQrels, consumed);
    if (best !== null) {
      consumed.add(best.index);
      dcg += gain(best.grade) / discount(r + 1);
    }
  }
  return dcg / idcg;
}

/**
 * The highest-grade still-unconsumed qrel this doc overlaps, or null.
 * Separated from the rank walk so the interesting step of nDCG (pick
 * the best match, consume it) reads on its own.
 */
function bestUnconsumedMatch(
  doc: RankedDoc,
  relevantQrels: ReadonlyArray<Qrel>,
  consumed: ReadonlySet<number>,
): { readonly index: number; readonly grade: number } | null {
  return [...relevantQrels.entries()]
    .filter(([index, q]) => !consumed.has(index) && qrelMatchesDoc(q, doc))
    .reduce<{ readonly index: number; readonly grade: number } | null>(
      (best, [index, q]) =>
        best === null || q.relevance > best.grade ? { index, grade: q.relevance } : best,
      null,
    );
}

function gain(rel: number): number {
  return 2 ** rel - 1;
}

function discount(rank: number): number {
  return Math.log2(rank + 1);
}

/**
 * Compute every headline metric for a single query. Used by the runner
 * to record per-query metrics in the run JSON.
 */
export function perQueryMetrics(
  rankedDocs: ReadonlyArray<RankedDoc>,
  qrels: ReadonlyArray<Qrel>,
): MetricSummary {
  const judged = judgeRanked(rankedDocs, qrels);
  return Object.freeze({
    hitAt1: hitAtK(judged, 1),
    hitAt3: hitAtK(judged, 3),
    hitAt10: hitAtK(judged, 10),
    mrrAt10: rrAtK(judged, K_MRR),
    ndcgAt10: ndcgAtK(rankedDocs, qrels, K_NDCG),
    recallAt20: recallAtK(rankedDocs, qrels, 20),
    recallAt50: recallAtK(rankedDocs, qrels, 50),
  });
}

/** Average a list of metric summaries elementwise. Empty list → all zeros. */
export function averageMetrics(rows: ReadonlyArray<MetricSummary>): MetricSummary {
  if (rows.length === 0) {
    return Object.freeze({
      hitAt1: 0,
      hitAt3: 0,
      hitAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      recallAt20: 0,
      recallAt50: 0,
    });
  }
  const sum = rows.reduce(
    (acc, r) => ({
      hitAt1: acc.hitAt1 + r.hitAt1,
      hitAt3: acc.hitAt3 + r.hitAt3,
      hitAt10: acc.hitAt10 + r.hitAt10,
      mrrAt10: acc.mrrAt10 + r.mrrAt10,
      ndcgAt10: acc.ndcgAt10 + r.ndcgAt10,
      recallAt20: acc.recallAt20 + r.recallAt20,
      recallAt50: acc.recallAt50 + r.recallAt50,
    }),
    {
      hitAt1: 0,
      hitAt3: 0,
      hitAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      recallAt20: 0,
      recallAt50: 0,
    },
  );
  const n = rows.length;
  return Object.freeze({
    hitAt1: sum.hitAt1 / n,
    hitAt3: sum.hitAt3 / n,
    hitAt10: sum.hitAt10 / n,
    mrrAt10: sum.mrrAt10 / n,
    ndcgAt10: sum.ndcgAt10 / n,
    recallAt20: sum.recallAt20 / n,
    recallAt50: sum.recallAt50 / n,
  });
}

export interface ScoredRun {
  readonly overall: MetricSummary;
  readonly byQueryType: Readonly<Record<string, MetricSummary>>;
  readonly perQuery: ReadonlyArray<PerQueryMetrics>;
}

/**
 * Score a full run: per-query metrics, per-query-type averages, overall
 * averages. Each query's qrels are looked up by queryId; queries with
 * no matching qrels are skipped (with a warning return, not a throw —
 * a stale runner output against an updated gold set should surface,
 * not crash the report).
 */
export function scoreRun(
  perQueryRanked: ReadonlyMap<string, ReadonlyArray<RankedDoc>>,
  qrels: ReadonlyArray<Qrel>,
  queryTypes: ReadonlyMap<string, QueryType>,
): ScoredRun {
  const grouped = groupQrelsByQuery(qrels);
  const perQuery: PerQueryMetrics[] = [];
  for (const [qid, queryQrels] of grouped) {
    const ranked = perQueryRanked.get(qid) ?? [];
    const qt = queryTypes.get(qid) ?? "concept";
    const metrics = perQueryMetrics(ranked, queryQrels);
    perQuery.push(
      Object.freeze<PerQueryMetrics>({
        queryId: qid as PerQueryMetrics["queryId"],
        queryType: qt,
        ...metrics,
      }),
    );
  }
  const overall = averageMetrics(perQuery);
  const byTypeBuckets = new Map<string, MetricSummary[]>();
  for (const p of perQuery) {
    const bucket = byTypeBuckets.get(p.queryType) ?? [];
    bucket.push(p);
    byTypeBuckets.set(p.queryType, bucket);
  }
  const byQueryType: Record<string, MetricSummary> = {};
  for (const [type, rows] of byTypeBuckets) {
    byQueryType[type] = averageMetrics(rows);
  }
  return Object.freeze({
    overall,
    byQueryType: Object.freeze(byQueryType),
    perQuery: Object.freeze(perQuery),
  });
}
