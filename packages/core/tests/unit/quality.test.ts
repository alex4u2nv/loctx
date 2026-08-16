/**
 * Unit tests for the heuristic quality analyzer (#522). Every rule is
 * exercised through the pure `computeQualityFindings` with plain-object
 * fixtures — fire and no-fire cases, threshold edges, and the
 * degradation paths (no lizard, null chunk metadata).
 */

import { describe, expect, it } from "vitest";
import type { LizardFileResult } from "../../src/analyzers/lizard.js";
import {
  computeQualityFindings,
  DEFAULT_QUALITY_THRESHOLDS,
  extractCandidates,
  fanInFinding,
  QUALITY_VERSION,
  type QualityChunkInfo,
  type QualityInput,
} from "../../src/analyzers/quality.js";
import type { AnalyzerMetadata } from "../../src/models.js";

function meta(overrides: Partial<AnalyzerMetadata> = {}): AnalyzerMetadata {
  return {
    imports: [],
    exports: [],
    calls: [],
    maxNestingDepth: 0,
    maxLoopDepth: 0,
    paramCount: 0,
    hasAsync: false,
    hasRecursionHint: false,
    riskyCalls: [],
    analysisSource: "test",
    analysisVersion: 1,
    ...overrides,
  };
}

function chunk(
  startLine: number,
  endLine: number,
  metadata: AnalyzerMetadata | null,
): QualityChunkInfo {
  return { startLine, endLine, metadata };
}

function input(overrides: Partial<QualityInput> = {}): QualityInput {
  return { content: "", chunks: [], lizard: null, ...overrides };
}

const OPTS = { thresholds: DEFAULT_QUALITY_THRESHOLDS, maxFindingsPerFile: 50 };

function ruleIds(result: ReturnType<typeof computeQualityFindings>): string[] {
  return result.findings.map((f) => f.ruleId);
}

function lines(count: number, prefix = "const x"): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i} = ${i};`).join("\n");
}

describe("quality/god-file", () => {
  const manyExports = Array.from({ length: 11 }, (_, i) => `e${i}`);

  it("fires when lines AND exports both exceed", () => {
    const result = computeQualityFindings(
      input({ content: lines(401), chunks: [chunk(1, 401, meta({ exports: manyExports }))] }),
      OPTS,
    );
    expect(ruleIds(result)).toContain("quality/god-file");
    const finding = result.findings.find((f) => f.ruleId === "quality/god-file");
    expect(finding?.severity).toBe("warning");
    expect(finding?.lineFrom).toBe(1);
    expect(finding?.message).toContain("401");
    expect(finding?.message).toContain("11");
  });

  it("stays silent on a long file with few exports", () => {
    const result = computeQualityFindings(
      input({ content: lines(401), chunks: [chunk(1, 401, meta({ exports: ["one"] }))] }),
      OPTS,
    );
    expect(ruleIds(result)).not.toContain("quality/god-file");
  });

  it("stays silent at exactly the thresholds (strictly-above semantics)", () => {
    const result = computeQualityFindings(
      input({
        content: lines(400),
        chunks: [chunk(1, 400, meta({ exports: manyExports.slice(0, 10) }))],
      }),
      OPTS,
    );
    expect(ruleIds(result)).not.toContain("quality/god-file");
  });

  it("ignores blank lines when counting", () => {
    const content = `${lines(390)}\n${"\n".repeat(50)}`;
    const result = computeQualityFindings(
      input({ content, chunks: [chunk(1, 440, meta({ exports: manyExports }))] }),
      OPTS,
    );
    expect(ruleIds(result)).not.toContain("quality/god-file");
  });
});

describe("quality/long-params", () => {
  const lizard: LizardFileResult = {
    file: "a.ts",
    functions: [
      { name: "wide", nloc: 10, ccn: 2, tokens: 40, parameters: 8, lineFrom: 5, lineTo: 20 },
      { name: "narrow", nloc: 5, ccn: 1, tokens: 20, parameters: 2, lineFrom: 22, lineTo: 30 },
    ],
  };

  it("uses lizard's per-function counts and ranges when available", () => {
    const result = computeQualityFindings(input({ lizard }), OPTS);
    const findings = result.findings.filter((f) => f.ruleId === "quality/long-params");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("'wide'");
    expect(findings[0]?.lineFrom).toBe(5);
    expect(findings[0]?.lineTo).toBe(20);
  });

  it("falls back to chunk metadata when lizard has not run", () => {
    const result = computeQualityFindings(
      input({
        chunks: [chunk(3, 12, meta({ paramCount: 7 })), chunk(14, 20, meta({ paramCount: 3 }))],
      }),
      OPTS,
    );
    const findings = result.findings.filter((f) => f.ruleId === "quality/long-params");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.lineFrom).toBe(3);
  });

  it("does not double-report from both sources", () => {
    const result = computeQualityFindings(
      input({ lizard, chunks: [chunk(5, 20, meta({ paramCount: 8 }))] }),
      OPTS,
    );
    expect(result.findings.filter((f) => f.ruleId === "quality/long-params")).toHaveLength(1);
  });

  it("falls back to chunk metadata when lizard ran but recognised no functions", () => {
    const empty: LizardFileResult = { file: "a.ts", functions: [] };
    const result = computeQualityFindings(
      input({ lizard: empty, chunks: [chunk(3, 12, meta({ paramCount: 9 }))] }),
      OPTS,
    );
    expect(result.findings.filter((f) => f.ruleId === "quality/long-params")).toHaveLength(1);
  });
});

describe("quality/deep-nesting", () => {
  it("flags a deeply-nested chunk at info severity", () => {
    const result = computeQualityFindings(
      input({ chunks: [chunk(10, 40, meta({ maxNestingDepth: 4 }))] }),
      OPTS,
    );
    const finding = result.findings.find((f) => f.ruleId === "quality/deep-nesting");
    expect(finding?.severity).toBe("info");
    expect(finding?.lineFrom).toBe(10);
  });

  it("escalates to warning when the overlapping lizard CCN exceeds the threshold", () => {
    const lizard: LizardFileResult = {
      file: "a.ts",
      functions: [
        { name: "hairy", nloc: 30, ccn: 24, tokens: 200, parameters: 2, lineFrom: 12, lineTo: 38 },
      ],
    };
    const result = computeQualityFindings(
      input({ lizard, chunks: [chunk(10, 40, meta({ maxNestingDepth: 5 }))] }),
      OPTS,
    );
    const finding = result.findings.find((f) => f.ruleId === "quality/deep-nesting");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("24");
  });

  it("stays info when the overlapping CCN is modest", () => {
    const lizard: LizardFileResult = {
      file: "a.ts",
      functions: [
        { name: "ok", nloc: 30, ccn: 4, tokens: 200, parameters: 2, lineFrom: 12, lineTo: 38 },
      ],
    };
    const result = computeQualityFindings(
      input({ lizard, chunks: [chunk(10, 40, meta({ maxNestingDepth: 5 }))] }),
      OPTS,
    );
    expect(result.findings.find((f) => f.ruleId === "quality/deep-nesting")?.severity).toBe("info");
  });

  it("stays silent below the depth threshold", () => {
    const result = computeQualityFindings(
      input({ chunks: [chunk(10, 40, meta({ maxNestingDepth: 3 }))] }),
      OPTS,
    );
    expect(ruleIds(result)).not.toContain("quality/deep-nesting");
  });
});

describe("quality/high-fan-out and high-fan-in", () => {
  it("fan-out fires above the distinct-import threshold, unioned across chunks", () => {
    const first = Array.from({ length: 15 }, (_, i) => `mod${i}`);
    const second = Array.from({ length: 15 }, (_, i) => `mod${i + 10}`); // overlaps 5
    const result = computeQualityFindings(
      input({
        chunks: [chunk(1, 10, meta({ imports: first })), chunk(11, 20, meta({ imports: second }))],
      }),
      OPTS,
    );
    const finding = result.findings.find((f) => f.ruleId === "quality/high-fan-out");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("25");
  });

  it("fan-out stays silent at exactly the threshold", () => {
    const imports = Array.from({ length: 20 }, (_, i) => `mod${i}`);
    const result = computeQualityFindings(
      input({ chunks: [chunk(1, 10, meta({ imports }))] }),
      OPTS,
    );
    expect(ruleIds(result)).not.toContain("quality/high-fan-out");
  });

  it("fan-in (query-time helper) fires above the threshold and reports the count", () => {
    const finding = fanInFinding(26, DEFAULT_QUALITY_THRESHOLDS);
    expect(finding?.ruleId).toBe("quality/high-fan-in");
    expect(finding?.message).toContain("26");
  });

  it("fan-in stays null at the threshold", () => {
    expect(fanInFinding(25, DEFAULT_QUALITY_THRESHOLDS)).toBeNull();
  });

  it("fan-in never fires from the enrichment pass (cross-file rule, #525)", () => {
    const result = computeQualityFindings(
      input({ chunks: [chunk(1, 10, meta({ exports: ["hub"] }))] }),
      OPTS,
    );
    expect(ruleIds(result)).not.toContain("quality/high-fan-in");
  });
});

describe("result envelope and degradation", () => {
  it("stamps the analyzer name and version", () => {
    const result = computeQualityFindings(input(), OPTS);
    expect(result.analyzer).toBe("quality");
    expect(result.toolVersion).toBe(String(QUALITY_VERSION));
    expect(result.findings).toEqual([]);
  });

  it("skips chunks without AST metadata (prose, pre-v3 chunks) cleanly", () => {
    const result = computeQualityFindings(
      input({ content: lines(500), chunks: [chunk(1, 500, null)] }),
      OPTS,
    );
    // god-file needs exports metadata, which null chunks can't supply.
    expect(result.findings).toEqual([]);
  });

  it("caps findings at maxFindingsPerFile", () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunk(i * 10 + 1, i * 10 + 9, meta({ maxNestingDepth: 6 })),
    );
    const result = computeQualityFindings(input({ chunks }), {
      thresholds: DEFAULT_QUALITY_THRESHOLDS,
      maxFindingsPerFile: 3,
    });
    expect(result.findings).toHaveLength(3);
  });

  it("respects overridden thresholds", () => {
    const result = computeQualityFindings(
      input({ chunks: [chunk(1, 10, meta({ imports: ["a", "b", "c"] }))] }),
      {
        thresholds: { ...DEFAULT_QUALITY_THRESHOLDS, maxFanOut: 2 },
        maxFindingsPerFile: 50,
      },
    );
    expect(ruleIds(result)).toContain("quality/high-fan-out");
  });
});

describe("extractCandidates (query-time, house rule: third caller)", () => {
  const member = (fileId: string, startLine = 1) => ({ fileId, startLine, endLine: startLine + 9 });

  it("flags every member of a group spanning three distinct files", () => {
    const candidates = extractCandidates([
      { hash: "h1", members: [member("f1"), member("f2"), member("f3")] },
    ]);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.fileId).sort()).toEqual(["f1", "f2", "f3"]);
    expect(candidates[0]?.finding.ruleId).toBe("quality/extract-candidate");
    expect(candidates[0]?.finding.severity).toBe("warning");
    expect(candidates[0]?.memberFiles).toBe(3);
  });

  it("ignores two-file groups by default (second caller is a watch, not a trigger)", () => {
    expect(extractCandidates([{ hash: "h1", members: [member("f1"), member("f2")] }])).toEqual([]);
  });

  it("counts distinct files, not members — two windows in one file don't fake a third caller", () => {
    const candidates = extractCandidates([
      { hash: "h1", members: [member("f1", 1), member("f1", 50), member("f2")] },
    ]);
    expect(candidates).toEqual([]);
  });

  it("honors a lowered minDistinctFiles", () => {
    const candidates = extractCandidates(
      [{ hash: "h1", members: [member("f1"), member("f2")] }],
      2,
    );
    expect(candidates).toHaveLength(2);
  });

  it("emits one finding per group for a file in several groups", () => {
    const candidates = extractCandidates([
      { hash: "h1", members: [member("f1"), member("f2"), member("f3")] },
      { hash: "h2", members: [member("f1", 80), member("f4"), member("f5")] },
    ]);
    expect(candidates.filter((c) => c.fileId === "f1")).toHaveLength(2);
  });
});
