/**
 * validateRunJson (CLI-11, 2026-08-06 audit): run files are an input
 * boundary; a truncated or hand-edited run must fail with a pointed
 * message instead of NaN report cells / 0-filled compare deltas.
 */

import { describe, expect, it } from "vitest";
import { RunJsonLoadError, validateRunJson } from "../src/run-json.js";

const metrics = {
  hitAt1: 1,
  hitAt3: 1,
  hitAt10: 1,
  mrrAt10: 1,
  ndcgAt10: 1,
  recallAt20: 1,
  recallAt50: 1,
};

const validRun = {
  runId: "20260806-120000-abc1234",
  goldenSet: "v1",
  corpusSha: "deadbeef",
  loctxSha: "abc1234",
  embedder: "fake",
  runtime: "node v22",
  chunkingConfig: "default",
  retrievalConfig: "hybrid|rrfK=60",
  chunkBoundaryHash: "0".repeat(64),
  metrics: {
    overall: metrics,
    byQueryType: { literal: metrics },
  },
  perQuery: [{ queryId: "q1", queryType: "literal", ...metrics }],
  startedAt: "2026-08-06T12:00:00.000Z",
  finishedAt: "2026-08-06T12:01:00.000Z",
};

describe("validateRunJson", () => {
  it("accepts a well-formed run", () => {
    const run = validateRunJson(validRun, "run.json");
    expect(run.runId).toBe(validRun.runId);
    expect(run.metrics.overall.ndcgAt10).toBe(1);
    expect(run.perQuery[0]?.queryType).toBe("literal");
  });

  it("rejects a missing top-level string field", () => {
    const { corpusSha: _dropped, ...rest } = validRun;
    expect(() => validateRunJson(rest, "run.json")).toThrow(RunJsonLoadError);
    expect(() => validateRunJson(rest, "run.json")).toThrow(/corpusSha/);
  });

  it("rejects a metric summary with a missing key", () => {
    const { ndcgAt10: _dropped, ...partial } = metrics;
    const bad = { ...validRun, metrics: { overall: partial, byQueryType: {} } };
    expect(() => validateRunJson(bad, "run.json")).toThrow(/metrics\.overall\.ndcgAt10/);
  });

  it("rejects an unknown perQuery queryType", () => {
    const bad = {
      ...validRun,
      perQuery: [{ queryId: "q1", queryType: "vibes", ...metrics }],
    };
    expect(() => validateRunJson(bad, "run.json")).toThrow(/queryType/);
  });

  it("rejects a non-object root", () => {
    expect(() => validateRunJson("[]", "run.json")).toThrow(RunJsonLoadError);
  });
});
