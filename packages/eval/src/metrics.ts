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
  MetricKey,
  MetricSummary,
  PerQueryMetrics,
  Qrel,
  QueryId,
  QueryType,
  RankedDoc,
  Relevance,
} from "./types.js";
import { METRIC_KEYS } from "./types.js";

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

/**
 * Average a list of metric summaries elementwise. Empty list → all
 * zeros. Folded over the shared `METRIC_KEYS` (CLI-5, 2026-08-06 audit)
 * so a new metric key can't be added to the summary type without this
 * reducer picking it up.
 */
export function averageMetrics(rows: ReadonlyArray<MetricSummary>): MetricSummary {
  const n = rows.length;
  const mean = (key: MetricKey): number =>
    n === 0 ? 0 : rows.reduce((acc, r) => acc + r[key], 0) / n;
  // Object.fromEntries widens to a string index; the keys are exactly
  // METRIC_KEYS, so the assertion restores what the compiler dropped.
  return Object.freeze(
    Object.fromEntries(METRIC_KEYS.map((key) => [key, mean(key)])) as Record<MetricKey, number>,
  );
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
 *
 * Throws when a qrels query has no entry in `queryTypes`: the runner
 * builds that map from the same grouped qrels it executes, so a miss
 * is a caller bug (mismatched runner output vs gold set), not a data
 * condition — silently defaulting to "concept" mis-bucketed the
 * per-type averages (2026-08-06 audit, "also noted").
 */
export function scoreRun(
  perQueryRanked: ReadonlyMap<QueryId, ReadonlyArray<RankedDoc>>,
  qrels: ReadonlyArray<Qrel>,
  queryTypes: ReadonlyMap<QueryId, QueryType>,
): ScoredRun {
  const grouped = groupQrelsByQuery(qrels);
  const perQuery: PerQueryMetrics[] = [];
  for (const [qid, queryQrels] of grouped) {
    const ranked = perQueryRanked.get(qid) ?? [];
    const qt = queryTypes.get(qid);
    if (qt === undefined) {
      throw new Error(
        `scoreRun: no query type recorded for '${qid}' — the ranked results and qrels disagree on the query set.`,
      );
    }
    const metrics = perQueryMetrics(ranked, queryQrels);
    perQuery.push(Object.freeze<PerQueryMetrics>({ queryId: qid, queryType: qt, ...metrics }));
  }
  const overall = averageMetrics(perQuery);
  const byQueryType: Record<string, MetricSummary> = {};
  for (const [type, rows] of Map.groupBy(perQuery, (p) => p.queryType)) {
    byQueryType[type] = averageMetrics(rows);
  }
  return Object.freeze({
    overall,
    byQueryType: Object.freeze(byQueryType),
    perQuery: Object.freeze(perQuery),
  });
}
