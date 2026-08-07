/**
 * Metric correctness tests against hand-computed fixtures.
 *
 * The point of these is to lock numerical outputs so a future refactor
 * of the metric module can't silently shift Hit@k or nDCG.
 */

import { describe, expect, it } from "vitest";
import {
  averageMetrics,
  hitAtK,
  ndcgAtK,
  perQueryMetrics,
  recallAtK,
  rrAtK,
  scoreRun,
} from "../src/metrics.js";
import { parseQrels } from "../src/qrels.js";
import type {
  PerQueryMetrics,
  Qrel,
  QueryId,
  QueryType,
  RankedDoc,
  Relevance,
} from "../src/types.js";
import { queryId } from "../src/types.js";

describe("hitAtK", () => {
  it("returns 1 when a relevant doc appears in top-k", () => {
    const judged: Relevance[] = [0, 0, 1, 0];
    expect(hitAtK(judged, 1)).toBe(0);
    expect(hitAtK(judged, 3)).toBe(1);
  });

  it("returns 0 on empty ranking", () => {
    expect(hitAtK([], 10)).toBe(0);
  });
});

describe("rrAtK", () => {
  it("returns reciprocal of first relevant rank", () => {
    expect(rrAtK([0, 0, 2], 10)).toBeCloseTo(1 / 3);
    expect(rrAtK([1, 0, 0], 10)).toBe(1);
  });

  it("returns 0 when nothing relevant in top-k", () => {
    expect(rrAtK([0, 0, 0, 0, 1], 4)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("perfect ranking → 1.0", () => {
    const qrels: Qrel[] = parseQrels(`
{"query_id":"q","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":1,"relevance":2,"provenance":"manual"}
{"query_id":"q","query":"x","query_type":"literal","rel_path":"b","start_line":1,"end_line":1,"relevance":1,"provenance":"manual"}
`) as Qrel[];
    const ranked: RankedDoc[] = [
      { relPath: "a", startLine: 1, endLine: 1, score: 1, rank: 1 },
      { relPath: "b", startLine: 1, endLine: 1, score: 0.5, rank: 2 },
    ];
    expect(ndcgAtK(ranked, qrels, 10)).toBeCloseTo(1.0);
  });

  it("swapping a graded-2 and graded-1 hit yields a known degradation", () => {
    const qrels: Qrel[] = parseQrels(`
{"query_id":"q","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":1,"relevance":2,"provenance":"manual"}
{"query_id":"q","query":"x","query_type":"literal","rel_path":"b","start_line":1,"end_line":1,"relevance":1,"provenance":"manual"}
`) as Qrel[];
    const ranked: RankedDoc[] = [
      { relPath: "b", startLine: 1, endLine: 1, score: 1, rank: 1 },
      { relPath: "a", startLine: 1, endLine: 1, score: 0.5, rank: 2 },
    ];
    // DCG = 1/log2(2) + 3/log2(3) = 1 + 1.8927892 ≈ 2.8927892
    // IDCG = 3/log2(2) + 1/log2(3) = 3 + 0.6309298 ≈ 3.6309298
    expect(ndcgAtK(ranked, qrels, 10)).toBeCloseTo(2.8927892 / 3.6309298, 4);
  });

  it("returns 0 when no qrels are relevant", () => {
    const ranked: RankedDoc[] = [{ relPath: "x", startLine: 1, endLine: 1, score: 1, rank: 1 }];
    expect(ndcgAtK(ranked, [], 10)).toBe(0);
  });

  it("does not double-credit two ranked chunks overlapping the same qrel", () => {
    const qrels: Qrel[] = parseQrels(`
{"query_id":"q","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":20,"relevance":2,"provenance":"manual"}
`) as Qrel[];
    const ranked: RankedDoc[] = [
      { relPath: "a", startLine: 1, endLine: 10, score: 1, rank: 1 },
      { relPath: "a", startLine: 11, endLine: 20, score: 0.9, rank: 2 },
    ];
    // Only the first chunk should count toward the single qrel.
    // DCG = 3/log2(2) = 3. IDCG = 3 (single graded-2 qrel).
    expect(ndcgAtK(ranked, qrels, 10)).toBeCloseTo(1.0);
  });
});

describe("recallAtK", () => {
  it("counts distinct relevant qrels covered, not chunks", () => {
    const qrels: Qrel[] = parseQrels(`
{"query_id":"q","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":10,"relevance":2,"provenance":"manual"}
{"query_id":"q","query":"x","query_type":"literal","rel_path":"b","start_line":1,"end_line":5,"relevance":1,"provenance":"manual"}
{"query_id":"q","query":"x","query_type":"literal","rel_path":"c","start_line":1,"end_line":5,"relevance":1,"provenance":"manual"}
`) as Qrel[];
    const ranked: RankedDoc[] = [
      { relPath: "a", startLine: 1, endLine: 5, score: 1, rank: 1 },
      { relPath: "a", startLine: 6, endLine: 10, score: 0.9, rank: 2 },
      { relPath: "b", startLine: 1, endLine: 5, score: 0.8, rank: 3 },
    ];
    expect(recallAtK(ranked, qrels, 10)).toBeCloseTo(2 / 3);
  });

  it("returns 0 when no relevant qrels", () => {
    expect(recallAtK([], [], 10)).toBe(0);
  });
});

describe("perQueryMetrics", () => {
  it("combines all metrics for the same ranking + qrels", () => {
    const qrels: Qrel[] = parseQrels(`
{"query_id":"q","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":1,"relevance":2,"provenance":"manual"}
`) as Qrel[];
    const ranked: RankedDoc[] = [{ relPath: "a", startLine: 1, endLine: 1, score: 1, rank: 1 }];
    const m = perQueryMetrics(ranked, qrels);
    expect(m.hitAt1).toBe(1);
    expect(m.hitAt3).toBe(1);
    expect(m.mrrAt10).toBe(1);
    expect(m.ndcgAt10).toBeCloseTo(1);
    expect(m.recallAt20).toBe(1);
  });
});

describe("averageMetrics", () => {
  it("averages elementwise", () => {
    const avg = averageMetrics([
      {
        hitAt1: 1,
        hitAt3: 1,
        hitAt10: 1,
        mrrAt10: 1,
        ndcgAt10: 1,
        recallAt20: 1,
        recallAt50: 1,
      },
      {
        hitAt1: 0,
        hitAt3: 0,
        hitAt10: 0,
        mrrAt10: 0,
        ndcgAt10: 0,
        recallAt20: 0,
        recallAt50: 0,
      },
    ]);
    expect(avg.hitAt1).toBe(0.5);
    expect(avg.ndcgAt10).toBe(0.5);
  });

  it("zero rows → all zeros", () => {
    const avg = averageMetrics([]);
    expect(avg.hitAt1).toBe(0);
  });
});

describe("scoreRun", () => {
  it("partitions metrics by query_type", () => {
    const qrels: Qrel[] = parseQrels(`
{"query_id":"q1","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":5,"relevance":2,"provenance":"manual"}
{"query_id":"q2","query":"y","query_type":"concept","rel_path":"b","start_line":1,"end_line":5,"relevance":1,"provenance":"manual"}
`) as Qrel[];
    const ranked = new Map<QueryId, RankedDoc[]>([
      [queryId("q1"), [{ relPath: "a", startLine: 1, endLine: 5, score: 1, rank: 1 }]],
      [queryId("q2"), [{ relPath: "z", startLine: 1, endLine: 5, score: 1, rank: 1 }]],
    ]);
    const types = new Map<QueryId, QueryType>([
      [queryId("q1"), "literal"],
      [queryId("q2"), "concept"],
    ]);
    const scored = scoreRun(ranked, qrels, types);
    expect(scored.overall.hitAt1).toBe(0.5);
    expect(scored.byQueryType["literal"]?.hitAt1).toBe(1);
    expect(scored.byQueryType["concept"]?.hitAt1).toBe(0);
    const literalRow = scored.perQuery.find((p: PerQueryMetrics) => p.queryId === queryId("q1"));
    expect(literalRow?.queryType).toBe("literal");
  });

  it("throws when a qrels query has no recorded query type", () => {
    // The runner derives queryTypes from the same grouped qrels it
    // executes, so a miss means mismatched inputs — surfaced loudly
    // instead of silently defaulting to "concept" (2026-08-06 audit).
    const qrels: Qrel[] = parseQrels(`
{"query_id":"q1","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":5,"relevance":2,"provenance":"manual"}
`) as Qrel[];
    expect(() => scoreRun(new Map(), qrels, new Map())).toThrow(/no query type recorded/);
  });
});
