/**
 * Gold-set validation classification (#469). The end-to-end command
 * indexes a corpus, but the per-qrel decision is pure and tested here:
 * a qrel whose span no longer maps to any chunk (a corrupted / drifted
 * docid) must be flagged so the command exits non-zero.
 */

import { describe, expect, it } from "vitest";
import { classify } from "../src/cmd/validate.js";
import type { Qrel } from "../src/types.js";
import { queryId } from "../src/types.js";

function qrel(startLine: number, endLine: number, relPath = "src/a.ts"): Qrel {
  return {
    queryId: queryId("q1"),
    query: "x",
    queryType: "symbol",
    relPath,
    startLine,
    endLine,
    relevance: 2,
    provenance: "test",
  };
}

describe("validate/classify (#469)", () => {
  it("exact: a chunk span matches the qrel span", () => {
    expect(classify(qrel(10, 20), [{ start: 10, end: 20 }]).status).toBe("exact");
  });

  it("drift: a chunk overlaps but no exact match (still resolvable)", () => {
    expect(classify(qrel(10, 20), [{ start: 5, end: 15 }]).status).toBe("drift");
    expect(classify(qrel(10, 20), [{ start: 18, end: 40 }]).status).toBe("drift");
    // Chunk fully contains the qrel span.
    expect(classify(qrel(10, 20), [{ start: 1, end: 100 }]).status).toBe("drift");
  });

  it("no-overlap: the file is indexed but no chunk covers the span (rot)", () => {
    expect(classify(qrel(10, 20), [{ start: 1, end: 9 }]).status).toBe("no-overlap");
    expect(classify(qrel(10, 20), [{ start: 21, end: 30 }]).status).toBe("no-overlap");
  });

  it("missing-file: the rel_path has no indexed chunks (rot)", () => {
    expect(classify(qrel(10, 20), undefined).status).toBe("missing-file");
    expect(classify(qrel(10, 20), []).status).toBe("missing-file");
  });

  it("carries the qrel identity through for the failure report", () => {
    const v = classify(qrel(10, 20, "src/gone.ts"), undefined);
    expect(v).toMatchObject({
      relPath: "src/gone.ts",
      startLine: 10,
      endLine: 20,
      status: "missing-file",
    });
  });
});
