/**
 * Quality report aggregation tests (#525): stub ports, deterministic
 * vectors, every merge/rank/cap path exercised without storage.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_THRESHOLDS } from "../../src/analyzers/quality.js";
import { buildQualityReport, type QualityReportPorts } from "../../src/analyzers/quality-report.js";
import { projectId } from "../../src/models.js";

const PID = projectId("p1");

function ports(overrides: Partial<QualityReportPorts> = {}): QualityReportPorts {
  return {
    qualityEnrichments: () => [],
    duplicateGroups: () => [],
    fanInCounts: () => new Map(),
    scanChunks: async () => [],
    listFiles: () => [
      { fileId: "f1", relPath: "src/a.ts" },
      { fileId: "f2", relPath: "src/b.ts" },
      { fileId: "f3", relPath: "docs/guide.md" },
    ],
    readFileContent: async () => null,
    exists: () => false,
    vectors: { chunkVectorsForPath: async () => [] },
    ...overrides,
  };
}

function opts(overrides: Partial<Parameters<typeof buildQualityReport>[1]> = {}) {
  return {
    projectId: PID,
    projectRoot: "/proj",
    thresholds: DEFAULT_QUALITY_THRESHOLDS,
    markdownRules: true,
    driftFloor: 0.35,
    limit: 20,
    ...overrides,
  };
}

const storedPayload = JSON.stringify({
  findings: [
    {
      ruleId: "quality/god-file",
      severity: "warning",
      message: "big",
      category: "architecture",
      lineFrom: 1,
      lineTo: 1,
    },
  ],
});

describe("buildQualityReport", () => {
  it("merges stored, duplicate-group, and fan-in findings and ranks by weight", async () => {
    const report = await buildQualityReport(
      ports({
        qualityEnrichments: () => [{ fileId: "f1", payloadJson: storedPayload }],
        duplicateGroups: () => [
          {
            hash: "h1",
            members: [
              { fileId: "f1", startLine: 1, endLine: 10 },
              { fileId: "f2", startLine: 5, endLine: 14 },
              { fileId: "f3", startLine: 9, endLine: 18 },
            ],
          },
        ],
        fanInCounts: () => new Map([["f2", 30]]),
      }),
      opts(),
    );
    // f1: god-file (2) + extract-candidate (2) = 4;
    // f2: extract-candidate (2) + high-fan-in (1) = 3;
    // f3: extract-candidate (2).
    expect(report.files.map((f) => f.fileId)).toEqual(["f1", "f2", "f3"]);
    expect(report.files[0]?.weight).toBe(4);
    expect(report.totals.findings).toBe(5);
    expect(report.totals.warnings).toBe(4);
    expect(report.totals.infos).toBe(1);
    // Rule rollup: sorted by count, with file spread + worst severity.
    expect(report.rules).toEqual([
      { ruleId: "quality/extract-candidate", count: 3, files: 3, worstSeverity: "warning" },
      { ruleId: "quality/god-file", count: 1, files: 1, worstSeverity: "warning" },
      { ruleId: "quality/high-fan-in", count: 1, files: 1, worstSeverity: "info" },
    ]);
  });

  it("fan-in below the threshold does not flag", async () => {
    const report = await buildQualityReport(
      ports({ fanInCounts: () => new Map([["f1", 25]]) }),
      opts(),
    );
    expect(report.files).toEqual([]);
  });

  it("applies the rule filter after merging", async () => {
    const report = await buildQualityReport(
      ports({
        qualityEnrichments: () => [{ fileId: "f1", payloadJson: storedPayload }],
        fanInCounts: () => new Map([["f1", 30]]),
      }),
      opts({ ruleFilter: "quality/high-fan-in" }),
    );
    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.findings.map((f) => f.ruleId)).toEqual(["quality/high-fan-in"]);
    // The rollup ignores the filter — widgets stay stable while drilling in.
    expect(report.rules.map((r) => r.ruleId).sort()).toEqual([
      "quality/god-file",
      "quality/high-fan-in",
    ]);
  });

  it("caps the file list at limit but totals count everything", async () => {
    const report = await buildQualityReport(
      ports({
        qualityEnrichments: () => [
          { fileId: "f1", payloadJson: storedPayload },
          { fileId: "f2", payloadJson: storedPayload },
        ],
      }),
      opts({ limit: 1 }),
    );
    expect(report.files).toHaveLength(1);
    expect(report.totals.files).toBe(2);
  });

  it("a malformed payload adds a note instead of sinking the report", async () => {
    const report = await buildQualityReport(
      ports({
        qualityEnrichments: () => [
          { fileId: "f1", payloadJson: "{not json" },
          { fileId: "f2", payloadJson: storedPayload },
        ],
      }),
      opts(),
    );
    expect(report.files.map((f) => f.fileId)).toEqual(["f2"]);
    expect(report.notes.some((n) => n.includes("unparseable"))).toBe(true);
  });

  it("skips group members that are no longer indexed", async () => {
    const report = await buildQualityReport(
      ports({
        duplicateGroups: () => [
          {
            hash: "h1",
            members: [
              { fileId: "gone", startLine: 1, endLine: 10 },
              { fileId: "f1", startLine: 1, endLine: 10 },
              { fileId: "f2", startLine: 1, endLine: 10 },
            ],
          },
        ],
      }),
      opts(),
    );
    expect(report.files.map((f) => f.fileId).sort()).toEqual(["f1", "f2"]);
  });

  it("notes the cohesion scan cap and the drift doc cap — no silent truncation", async () => {
    const chunk = (i: number) => ({
      chunkId: `c${i}`,
      fileId: "f1",
      relPath: "src/a.ts",
      startLine: 1,
      endLine: 5,
      vector: [1, 0],
    });
    const manyDocs = Array.from({ length: 3 }, (_, i) => ({
      fileId: `d${i}`,
      relPath: `docs/${i}.md`,
    }));
    const report = await buildQualityReport(
      ports({
        scanChunks: async () => [chunk(1), chunk(2), chunk(3)],
        listFiles: () => manyDocs,
      }),
      opts({ scanCap: 2, maxDriftDocs: 1 }),
    );
    expect(report.notes.some((n) => n.includes("cohesion scan capped at 2"))).toBe(true);
    expect(report.notes.some((n) => n.includes("1 of 3 markdown files"))).toBe(true);
  });

  it("reports doc-drift for a markdown file whose refs diverge", async () => {
    const report = await buildQualityReport(
      ports({
        readFileContent: async () => "see `src/a.ts` for details",
        exists: (p) => p === "/proj/src/a.ts",
        vectors: {
          chunkVectorsForPath: async (_pid, relPath) =>
            relPath === "docs/guide.md" ? [new Float32Array([1, 0])] : [new Float32Array([0, 1])],
        },
      }),
      opts(),
    );
    const doc = report.files.find((f) => f.fileId === "f3");
    expect(doc?.findings.map((f) => f.ruleId)).toEqual(["quality/doc-drift"]);
  });
});

describe("per-file display cap", () => {
  it("caps displayed findings per file, keeps full weight, and notes it", async () => {
    const groups = Array.from({ length: 60 }, (_, i) => ({
      hash: `h${i}`,
      members: [
        { fileId: "f1", startLine: i + 1, endLine: i + 10 },
        { fileId: "f2", startLine: 1, endLine: 10 },
        { fileId: "f3", startLine: 1, endLine: 10 },
      ],
    }));
    const report = await buildQualityReport(ports({ duplicateGroups: () => groups }), opts());
    const f1 = report.files.find((f) => f.fileId === "f1");
    expect(f1?.findings).toHaveLength(50);
    expect(f1?.weight).toBe(120); // 60 warnings x 2 — all counted
    expect(report.notes.some((n) => n.includes("showing 50 of 60"))).toBe(true);
  });
});

describe("suppressions + baseline (#566)", () => {
  const suppressionState = (
    overrides: Partial<{
      suppressions: Array<{ rule: string; path: string; reason: string }>;
      baseline: Set<string>;
      problems: string[];
    }> = {},
  ) => ({
    suppressions: overrides.suppressions ?? [],
    baseline: overrides.baseline ?? new Set<string>(),
    problems: overrides.problems ?? [],
  });

  it("excludes suppressed findings from files, rollups, and totals — but counts them", async () => {
    const report = await buildQualityReport(
      ports({
        qualityEnrichments: () => [{ fileId: "f1", payloadJson: storedPayload }],
        fanInCounts: () => new Map([["f2", 30]]),
      }),
      opts({
        suppressionState: suppressionState({
          suppressions: [{ rule: "quality/god-file", path: "src/**", reason: "accepted" }],
        }),
      }),
    );
    expect(report.files.map((f) => f.fileId)).toEqual(["f2"]);
    expect(report.rules.map((r) => r.ruleId)).toEqual(["quality/high-fan-in"]);
    expect(report.totals.findings).toBe(1);
    expect(report.totals.suppressed).toBe(1);
    expect(report.notes.some((n) => n.includes("1 finding(s) suppressed"))).toBe(true);
  });

  it("baseline entries suppress exact (rule, path) pairs only", async () => {
    const { baselineKey } = await import("../../src/analyzers/quality-suppressions.js");
    const report = await buildQualityReport(
      ports({
        qualityEnrichments: () => [{ fileId: "f1", payloadJson: storedPayload }],
        fanInCounts: () => new Map([["f2", 30]]),
      }),
      opts({
        suppressionState: suppressionState({
          baseline: new Set([baselineKey("quality/god-file", "src/a.ts")]),
        }),
      }),
    );
    expect(report.files.map((f) => f.fileId)).toEqual(["f2"]);
    expect(report.totals.suppressed).toBe(1);
    expect(report.notes.some((n) => n.includes("baseline"))).toBe(true);
  });

  it("includeSuppressed keeps the findings visible while still counting them", async () => {
    const report = await buildQualityReport(
      ports({ qualityEnrichments: () => [{ fileId: "f1", payloadJson: storedPayload }] }),
      opts({
        suppressionState: suppressionState({
          suppressions: [{ rule: "*", path: "**", reason: "show me" }],
        }),
        includeSuppressed: true,
      }),
    );
    expect(report.files.map((f) => f.fileId)).toEqual(["f1"]);
    expect(report.totals.suppressed).toBe(1);
    expect(report.notes.some((n) => n.includes("showing 1 suppressed"))).toBe(true);
  });

  it("loader problems surface as notes and totals.suppressed defaults to 0", async () => {
    const report = await buildQualityReport(
      ports({ qualityEnrichments: () => [{ fileId: "f1", payloadJson: storedPayload }] }),
      opts({
        suppressionState: suppressionState({ problems: [".loctx-quality.yaml: entry 1 bad"] }),
      }),
    );
    expect(report.totals.suppressed).toBe(0);
    expect(report.notes).toContain(".loctx-quality.yaml: entry 1 bad");
    expect(report.files).toHaveLength(1);
  });
});
