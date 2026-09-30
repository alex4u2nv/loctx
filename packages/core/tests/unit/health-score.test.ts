import { describe, expect, it } from "vitest";
import {
  type CodeHealth,
  computeCodeHealth,
  gradeFor,
  HEALTH_VERSION,
} from "../../src/analyzers/health-score.js";
import type { QualityReport, QualityReportFile } from "../../src/analyzers/quality-report.js";
import type { RulePackFinding } from "../../src/analyzers/rule-pack.js";

function finding(
  ruleId: string,
  severity: RulePackFinding["severity"] = "warning",
): RulePackFinding {
  return { ruleId, severity, message: ruleId, lineFrom: 1, lineTo: 2 } as RulePackFinding;
}

function file(relPath: string, findings: RulePackFinding[]): QualityReportFile {
  return { fileId: relPath, relPath, weight: 0, findings };
}

function report(files: QualityReportFile[], notes: string[] = [], suppressed = 0): QualityReport {
  return {
    files,
    rules: [],
    totals: { files: files.length, findings: 0, errors: 0, warnings: 0, infos: 0, suppressed },
    notes,
  };
}

const dim = (h: CodeHealth, id: string) => {
  const d = h.dimensions.find((x) => x.id === id);
  if (d === undefined) throw new Error(`no dimension ${id}`);
  return d;
};

describe("computeCodeHealth", () => {
  it("scores a clean project 100 / A across every dimension", () => {
    const h = computeCodeHealth({
      report: report([]),
      indexedFiles: 40,
      storedRulesAvailable: true,
    });
    expect(h.score).toBe(100);
    expect(h.grade).toBe("A");
    expect(h.version).toBe(HEALTH_VERSION);
    expect(h.dimensions.every((d) => d.score === 100 && d.coverage === "full")).toBe(true);
    expect(h.basis).toEqual({ indexedFiles: 40, findings: 0, suppressed: 0, unmappedFindings: 0 });
    expect(h.notes).toEqual([]);
  });

  it("buckets rules into dimensions and weights by severity", () => {
    const h = computeCodeHealth({
      report: report([
        file("a.ts", [
          finding("quality/deep-nesting", "error"),
          finding("quality/long-params", "info"),
        ]),
        file("b.ts", [finding("quality/high-fan-in"), finding("quality/extract-candidate")]),
        file("c.md", [finding("quality/doc-drift"), finding("definitions/broken-link", "error")]),
      ]),
      indexedFiles: 10,
      storedRulesAvailable: true,
    });
    expect(dim(h, "complexity")).toMatchObject({ findings: 2, weightedFindings: 4, density: 0.4 });
    expect(dim(h, "coupling")).toMatchObject({ findings: 1, weightedFindings: 2 });
    expect(dim(h, "duplication")).toMatchObject({ findings: 1, weightedFindings: 2 });
    expect(dim(h, "cohesion")).toMatchObject({ findings: 0, score: 100 });
    expect(dim(h, "documentation")).toMatchObject({ findings: 2, weightedFindings: 5 });
    expect(h.basis.findings).toBe(6);
  });

  it("reads 50 at a dimension's half-point density and degrades smoothly past it", () => {
    // complexity halfPoint = 0.6 weighted findings per file: 3 warnings (6) over 10 files.
    const at = computeCodeHealth({
      report: report([
        file("a.ts", [
          finding("quality/god-file"),
          finding("quality/god-file"),
          finding("quality/god-file"),
        ]),
      ]),
      indexedFiles: 10,
      storedRulesAvailable: true,
    });
    expect(dim(at, "complexity").score).toBe(50);
    const worse = computeCodeHealth({
      report: report([
        file(
          "a.ts",
          Array.from({ length: 30 }, () => finding("quality/god-file")),
        ),
      ]),
      indexedFiles: 10,
      storedRulesAvailable: true,
    });
    expect(dim(worse, "complexity").score).toBeLessThan(20);
    expect(dim(worse, "complexity").score).toBeGreaterThan(0);
  });

  it("overall is the weight-normalised mean and grades by floor", () => {
    const h = computeCodeHealth({
      report: report([
        file(
          "a.ts",
          Array.from({ length: 3 }, () => finding("quality/god-file")),
        ),
      ]),
      indexedFiles: 10,
      storedRulesAvailable: true,
    });
    // complexity 50 at weight 0.3, everything else 100 → 85.
    expect(h.score).toBe(85);
    expect(h.grade).toBe("B");
  });

  it("drops stored-only dimensions when the quality analyzer is off and says so", () => {
    const h = computeCodeHealth({
      report: report([file("a.ts", [finding("quality/high-fan-in")])]),
      indexedFiles: 10,
      storedRulesAvailable: false,
    });
    expect(dim(h, "complexity").coverage).toBe("none");
    expect(dim(h, "coupling").coverage).toBe("partial");
    expect(dim(h, "duplication").coverage).toBe("full");
    // complexity excluded: coupling 100/(1+0.2/0.3)=60 at 0.2, rest 100 over weight 0.7 → 89.
    expect(h.score).toBe(89);
    expect(h.notes.some((n) => n.startsWith("complexity not scored"))).toBe(true);
    expect(h.notes.some((n) => n.includes("scored from query-time rules only"))).toBe(true);
  });

  it("counts unmapped rules in the basis and notes but never in the score", () => {
    const h = computeCodeHealth({
      report: report(
        [file("a.ts", [finding("semgrep/js.sql-injection", "error")])],
        ["cap hit"],
        4,
      ),
      indexedFiles: 3,
      storedRulesAvailable: true,
    });
    expect(h.score).toBe(100);
    expect(h.basis.unmappedFindings).toBe(1);
    expect(h.basis.suppressed).toBe(4);
    expect(h.notes).toContain("cap hit");
    expect(h.notes.some((n) => n.includes("semgrep/js.sql-injection"))).toBe(true);
  });

  it("never divides by zero on an empty project", () => {
    const h = computeCodeHealth({
      report: report([]),
      indexedFiles: 0,
      storedRulesAvailable: true,
    });
    expect(h.score).toBe(100);
  });
});

describe("gradeFor", () => {
  it("uses inclusive floors at 90/80/70/60", () => {
    expect([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(gradeFor)).toEqual([
      "A",
      "A",
      "B",
      "B",
      "C",
      "C",
      "D",
      "D",
      "F",
      "F",
    ]);
  });
});
