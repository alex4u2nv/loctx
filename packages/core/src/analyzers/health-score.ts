/**
 * Code Health score (#health): one 0–100 number per project, derived
 * from the quality report so every signal loctx already computes feeds
 * it and nothing new runs during indexing.
 *
 * Model
 * -----
 * Findings are bucketed into five dimensions by ruleId. Each dimension
 * has a severity-weighted finding count (error 3, warning 2, info 1 —
 * the same weights the report ranks files by), normalised by the
 * project's indexed file count into a *density* (weighted findings per
 * file). The dimension score is
 *
 *     100 / (1 + density / halfPoint)
 *
 * so a clean dimension is 100, `halfPoint` is the density at which it
 * reads 50, and the curve never bottoms out at a hard 0 — a project can
 * always get worse, and the score keeps ranking. The overall score is
 * the weighted mean of the dimension scores.
 *
 * Coverage
 * --------
 * Some rules are computed at enrichment time and stored; when the
 * quality analyzer is off those findings are simply absent, which would
 * read as a perfect dimension. A dimension whose rules are all stored is
 * then marked `coverage: "none"` and dropped from the overall (weights
 * renormalise); a mixed dimension is `"partial"` and still counts. Both
 * are stated in `notes` — never a silently flattering number.
 *
 * Calibration
 * -----------
 * `halfPoint` values come from scoring loctx itself and are deliberately
 * coarse. They are constants, not config, until there is evidence a
 * project needs to tune them; suppressions and the baseline (#566) are
 * the sanctioned way to accept debt without moving the goalposts.
 */

import type { QualityReport } from "./quality-report.js";
import { SEVERITY_WEIGHT } from "./quality-report.js";

export const HEALTH_VERSION = 1;

export type HealthDimensionId =
  | "complexity"
  | "coupling"
  | "duplication"
  | "cohesion"
  | "documentation";

export type HealthGrade = "A" | "B" | "C" | "D" | "F";

/** How much of a dimension's rule set could have produced findings. */
export type HealthCoverage = "full" | "partial" | "none";

export interface HealthDimension {
  readonly id: HealthDimensionId;
  readonly label: string;
  /** Share of the overall score (weights sum to 1 across dimensions). */
  readonly weight: number;
  /** 0..100; 100 when no findings. */
  readonly score: number;
  readonly findings: number;
  readonly weightedFindings: number;
  /** Weighted findings per indexed file. */
  readonly density: number;
  readonly coverage: HealthCoverage;
}

export interface CodeHealth {
  readonly version: number;
  /** 0..100 weighted mean of the scorable dimensions. */
  readonly score: number;
  readonly grade: HealthGrade;
  readonly dimensions: ReadonlyArray<HealthDimension>;
  readonly basis: {
    readonly indexedFiles: number;
    /** Findings that entered the score (suppressed ones never do). */
    readonly findings: number;
    readonly suppressed: number;
    /** Findings whose ruleId maps to no dimension (e.g. semgrep packs). */
    readonly unmappedFindings: number;
  };
  /** Coverage caveats, carried over report notes, unmapped rules. */
  readonly notes: ReadonlyArray<string>;
}

export interface HealthInput {
  /** A FULL report (limit = MAX_SAFE_INTEGER) — a capped one under-counts. */
  readonly report: QualityReport;
  readonly indexedFiles: number;
  /** False when analyzers.quality is off, so stored rules never ran. */
  readonly storedRulesAvailable: boolean;
}

interface DimensionSpec {
  readonly id: HealthDimensionId;
  readonly label: string;
  readonly weight: number;
  /** Density (weighted findings per file) at which the score reads 50. */
  readonly halfPoint: number;
  /** Rules computed at enrichment time and persisted. */
  readonly storedRules: ReadonlyArray<string>;
  /** Rules computed at query time from the index. */
  readonly liveRules: ReadonlyArray<string>;
}

const DIMENSIONS: ReadonlyArray<DimensionSpec> = Object.freeze([
  {
    id: "complexity",
    label: "Complexity",
    weight: 0.3,
    halfPoint: 0.6,
    storedRules: ["quality/deep-nesting", "quality/long-params", "quality/god-file"],
    liveRules: [],
  },
  {
    id: "coupling",
    label: "Coupling",
    weight: 0.2,
    halfPoint: 0.3,
    storedRules: ["quality/high-fan-out"],
    liveRules: ["quality/high-fan-in"],
  },
  {
    id: "duplication",
    label: "Duplication",
    weight: 0.2,
    halfPoint: 0.3,
    storedRules: [],
    liveRules: ["quality/extract-candidate"],
  },
  {
    id: "cohesion",
    label: "Cohesion",
    weight: 0.15,
    halfPoint: 0.2,
    storedRules: [],
    liveRules: ["quality/low-cohesion"],
  },
  {
    id: "documentation",
    label: "Documentation",
    weight: 0.15,
    halfPoint: 0.3,
    storedRules: ["quality/stale-ref"],
    liveRules: ["quality/doc-drift", "definitions/"],
  },
]);

const GRADE_FLOORS: ReadonlyArray<readonly [HealthGrade, number]> = Object.freeze([
  ["A", 90],
  ["B", 80],
  ["C", 70],
  ["D", 60],
]);

export function gradeFor(score: number): HealthGrade {
  return GRADE_FLOORS.find(([, floor]) => score >= floor)?.[0] ?? "F";
}

/** Exact ruleId, or a trailing-slash prefix (`definitions/`) for a family. */
function matchesRule(pattern: string, ruleId: string): boolean {
  return pattern.endsWith("/") ? ruleId.startsWith(pattern) : ruleId === pattern;
}

function dimensionFor(ruleId: string): DimensionSpec | null {
  return (
    DIMENSIONS.find((d) =>
      [...d.storedRules, ...d.liveRules].some((pattern) => matchesRule(pattern, ruleId)),
    ) ?? null
  );
}

function coverageFor(spec: DimensionSpec, storedRulesAvailable: boolean): HealthCoverage {
  if (storedRulesAvailable || spec.storedRules.length === 0) return "full";
  return spec.liveRules.length === 0 ? "none" : "partial";
}

function dimensionScore(density: number, halfPoint: number): number {
  return Math.round(100 / (1 + density / halfPoint));
}

export function computeCodeHealth(input: HealthInput): CodeHealth {
  const files = Math.max(1, input.indexedFiles);
  const tally = new Map<HealthDimensionId, { findings: number; weighted: number }>(
    DIMENSIONS.map((d) => [d.id, { findings: 0, weighted: 0 }]),
  );
  const unmapped = new Map<string, number>();
  let counted = 0;
  for (const file of input.report.files) {
    for (const f of file.findings) {
      const spec = dimensionFor(f.ruleId);
      if (spec === null) {
        unmapped.set(f.ruleId, (unmapped.get(f.ruleId) ?? 0) + 1);
        continue;
      }
      const t = tally.get(spec.id);
      if (t === undefined) continue;
      t.findings += 1;
      t.weighted += SEVERITY_WEIGHT[f.severity];
      counted += 1;
    }
  }

  const dimensions: HealthDimension[] = DIMENSIONS.map((spec) => {
    const t = tally.get(spec.id) ?? { findings: 0, weighted: 0 };
    const density = t.weighted / files;
    return {
      id: spec.id,
      label: spec.label,
      weight: spec.weight,
      score: dimensionScore(density, spec.halfPoint),
      findings: t.findings,
      weightedFindings: t.weighted,
      density,
      coverage: coverageFor(spec, input.storedRulesAvailable),
    };
  });

  const scorable = dimensions.filter((d) => d.coverage !== "none");
  const weightSum = scorable.reduce((sum, d) => sum + d.weight, 0);
  const score =
    weightSum > 0
      ? Math.round(scorable.reduce((sum, d) => sum + d.score * d.weight, 0) / weightSum)
      : 100;

  const notes: string[] = [];
  const dropped = dimensions.filter((d) => d.coverage === "none");
  if (dropped.length > 0) {
    notes.push(
      `${dropped.map((d) => d.label.toLowerCase()).join(", ")} not scored: analyzers.quality is off, so its stored rules never ran — overall excludes it`,
    );
  }
  const partial = dimensions.filter((d) => d.coverage === "partial");
  if (partial.length > 0) {
    notes.push(
      `${partial.map((d) => d.label.toLowerCase()).join(", ")} scored from query-time rules only (stored rules off)`,
    );
  }
  const unmappedTotal = [...unmapped.values()].reduce((sum, n) => sum + n, 0);
  if (unmappedTotal > 0) {
    notes.push(
      `${unmappedTotal} finding(s) outside the health model (${[...unmapped.keys()].sort().join(", ")}) — listed in the quality report, not scored`,
    );
  }
  notes.push(...input.report.notes);

  return Object.freeze({
    version: HEALTH_VERSION,
    score,
    grade: gradeFor(score),
    dimensions: Object.freeze(dimensions),
    basis: {
      indexedFiles: input.indexedFiles,
      findings: counted,
      suppressed: input.report.totals.suppressed,
      unmappedFindings: unmappedTotal,
    },
    notes: Object.freeze(notes),
  });
}
