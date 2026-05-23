import { describe, expect, it } from "vitest";
import { docidFor, formatTrec } from "../src/trec.js";
import type { QueryRunResult } from "../src/types.js";
import { queryId } from "../src/types.js";

describe("docidFor", () => {
  it("joins relPath with line span", () => {
    expect(docidFor("a/b.ts", 10, 20)).toBe("a/b.ts:10-20");
  });
});

describe("formatTrec", () => {
  it("emits one line per ranked doc in TREC format", () => {
    const results: QueryRunResult[] = [
      {
        queryId: queryId("q1"),
        query: "x",
        queryType: "literal",
        ranked: [
          { relPath: "a", startLine: 1, endLine: 2, score: 0.9, rank: 1 },
          { relPath: "b", startLine: 3, endLine: 4, score: 0.5, rank: 2 },
        ],
      },
    ];
    const out = formatTrec(results, "loctx-v1");
    expect(out).toBe("q1 Q0 a:1-2 1 0.900000 loctx-v1\nq1 Q0 b:3-4 2 0.500000 loctx-v1\n");
  });

  it("empty results → empty string", () => {
    expect(formatTrec([], "x")).toBe("");
  });
});
