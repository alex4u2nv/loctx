import { describe, expect, it } from "vitest";
import {
  groupQrelsByQuery,
  judgeRanked,
  parseQrels,
  QrelsLoadError,
  spansOverlap,
} from "../src/qrels.js";
import type { RankedDoc } from "../src/types.js";

describe("parseQrels", () => {
  it("parses one row per non-blank, non-comment line", () => {
    const text = `
# header
{"query_id":"q1","query":"foo","query_type":"literal","rel_path":"a.ts","start_line":1,"end_line":5,"relevance":2,"provenance":"manual"}
// comment
{"query_id":"q1","query":"foo","query_type":"literal","rel_path":"a.ts","start_line":10,"end_line":12,"relevance":1,"provenance":"manual","notes":"secondary"}
`;
    const qrels = parseQrels(text);
    expect(qrels).toHaveLength(2);
    expect(qrels[0]?.relevance).toBe(2);
    expect(qrels[1]?.notes).toBe("secondary");
  });

  it("rejects bad query_type with line number", () => {
    const text = `{"query_id":"q1","query":"x","query_type":"bogus","rel_path":"a","start_line":1,"end_line":2,"relevance":1,"provenance":"manual"}`;
    expect(() => parseQrels(text, "test.jsonl")).toThrowError(/test\.jsonl:1.*query_type/);
  });

  it("rejects end_line < start_line", () => {
    const text = `{"query_id":"q1","query":"x","query_type":"literal","rel_path":"a","start_line":10,"end_line":5,"relevance":1,"provenance":"manual"}`;
    expect(() => parseQrels(text)).toThrowError(QrelsLoadError);
  });

  it("rejects missing required field", () => {
    const text = `{"query_id":"q1","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":2,"relevance":1}`;
    expect(() => parseQrels(text)).toThrowError(/provenance/);
  });

  it("rejects malformed JSON with the offending line", () => {
    const text = "{not json}";
    expect(() => parseQrels(text, "x")).toThrowError(/x:1.*invalid JSON/);
  });
});

describe("groupQrelsByQuery", () => {
  it("collects multiple spans per queryId in order", () => {
    const qrels = parseQrels(`
{"query_id":"q1","query":"x","query_type":"literal","rel_path":"a","start_line":1,"end_line":2,"relevance":1,"provenance":"manual"}
{"query_id":"q1","query":"x","query_type":"literal","rel_path":"b","start_line":1,"end_line":2,"relevance":2,"provenance":"manual"}
{"query_id":"q2","query":"y","query_type":"concept","rel_path":"c","start_line":1,"end_line":2,"relevance":1,"provenance":"manual"}
`);
    const grouped = groupQrelsByQuery(qrels);
    expect(grouped.size).toBe(2);
    expect(grouped.get("q1")).toHaveLength(2);
    expect(grouped.get("q2")).toHaveLength(1);
  });
});

describe("spansOverlap", () => {
  it("returns true when ranges share at least one line", () => {
    expect(spansOverlap({ startLine: 1, endLine: 5 }, { startLine: 5, endLine: 10 })).toBe(true);
    expect(spansOverlap({ startLine: 1, endLine: 5 }, { startLine: 3, endLine: 4 })).toBe(true);
  });

  it("returns false on disjoint ranges", () => {
    expect(spansOverlap({ startLine: 1, endLine: 5 }, { startLine: 6, endLine: 10 })).toBe(false);
  });

  it("handles equal single-line spans", () => {
    expect(spansOverlap({ startLine: 7, endLine: 7 }, { startLine: 7, endLine: 7 })).toBe(true);
  });
});

describe("judgeRanked", () => {
  it("tags each ranked doc with the highest relevance it overlaps", () => {
    const qrels = parseQrels(`
{"query_id":"q1","query":"x","query_type":"literal","rel_path":"a.ts","start_line":10,"end_line":20,"relevance":1,"provenance":"manual"}
{"query_id":"q1","query":"x","query_type":"literal","rel_path":"a.ts","start_line":15,"end_line":18,"relevance":2,"provenance":"manual"}
{"query_id":"q1","query":"x","query_type":"literal","rel_path":"b.ts","start_line":1,"end_line":3,"relevance":1,"provenance":"manual"}
`);
    const ranked: RankedDoc[] = [
      { relPath: "a.ts", startLine: 16, endLine: 17, score: 1, rank: 1 },
      { relPath: "b.ts", startLine: 1, endLine: 3, score: 0.9, rank: 2 },
      { relPath: "c.ts", startLine: 1, endLine: 99, score: 0.1, rank: 3 },
    ];
    expect(judgeRanked(ranked, qrels)).toEqual([2, 1, 0]);
  });
});
