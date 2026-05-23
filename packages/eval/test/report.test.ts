import { describe, expect, it } from "vitest";
import { renderCompare, renderReport } from "../src/report.js";
import type { RunResultJson } from "../src/types.js";

const ZERO_METRICS = {
  hitAt1: 0,
  hitAt3: 0,
  hitAt10: 0,
  mrrAt10: 0,
  ndcgAt10: 0,
  recallAt20: 0,
  recallAt50: 0,
} as const;

function makeRun(overrides: Partial<RunResultJson> = {}): RunResultJson {
  return {
    runId: "20260523-000000-abcdef0",
    goldenSet: "v1",
    corpusSha: "abc1234",
    loctxSha: "def5678",
    embedder: "fake|test|d=16|n=1",
    runtime: "node v22.0.0",
    chunkingConfig: "default",
    retrievalConfig: "hybrid|rrfK=60",
    chunkBoundaryHash: "00ff",
    metrics: {
      overall: ZERO_METRICS,
      byQueryType: { literal: ZERO_METRICS },
    },
    perQuery: [
      {
        queryId: "q1" as RunResultJson["perQuery"][number]["queryId"],
        queryType: "literal",
        ...ZERO_METRICS,
      },
    ],
    startedAt: "2026-05-23T00:00:00.000Z",
    finishedAt: "2026-05-23T00:00:01.000Z",
    ...overrides,
  };
}

describe("renderReport", () => {
  it("includes the six headline metrics and per-query rows", () => {
    const md = renderReport(makeRun());
    expect(md).toContain("# loctx eval report");
    expect(md).toContain("Hit@1");
    expect(md).toContain("MRR@10");
    expect(md).toContain("Recall@50");
    expect(md).toContain("| `q1` | literal |");
  });
});

describe("renderCompare", () => {
  it("emits a delta column and a warning on gold-set mismatch", () => {
    const a = makeRun({ goldenSet: "v1" });
    const b = makeRun({
      goldenSet: "v2",
      metrics: {
        overall: { ...ZERO_METRICS, hitAt1: 0.5 },
        byQueryType: { literal: ZERO_METRICS },
      },
    });
    const md = renderCompare(a, b);
    expect(md).toContain("gold sets differ");
    expect(md).toContain("+0.500");
  });

  it("renders a `·` for zero delta", () => {
    const md = renderCompare(makeRun(), makeRun());
    expect(md).toContain("·");
  });
});
