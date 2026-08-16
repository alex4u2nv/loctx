/**
 * Search-result enrichment attachment (#542 split from searcher.ts):
 * the wire types plus the file_enrichments readers that surface
 * lizard metrics and rule-pack findings on results. Pure reads;
 * WorkspaceSearcher.attachEnrichments orchestrates.
 */

import type { FileId } from "../models.js";
import type { StateStore } from "../storage/index.js";

export interface SearchResultEnrichments {
  /**
   * Per-function complexity from the lizard analyzer (#62). Set when
   * the analyzer ran successfully on the file and the function
   * overlaps this chunk's line range. Null otherwise.
   */
  readonly lizard: LizardEnrichmentMetric | null;
  /**
   * Rule-pack findings (Semgrep, ast-grep) (#64) whose line range
   * overlaps this chunk's. Sorted by severity (error > warning > info)
   * then by line. Empty when no analyzer ran or nothing matched.
   */
  readonly findings: ReadonlyArray<RulePackFindingEnrichment>;
}

export interface RulePackFindingEnrichment {
  /** Analyzer name (`semgrep` | `ast-grep` | `quality`). */
  readonly analyzer: string;
  readonly ruleId: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly category: string;
  readonly lineFrom: number;
  readonly lineTo: number;
}

export interface LizardEnrichmentMetric {
  readonly functionName: string;
  /** Cyclomatic complexity. */
  readonly ccn: number;
  /** Non-comment lines of code. */
  readonly nloc: number;
  readonly tokens: number;
  readonly parameters: number;
  /** Function line range from lizard's report (may differ slightly from chunk). */
  readonly lineFrom: number;
  readonly lineTo: number;
}

export function emptyEnrichments(): SearchResultEnrichments {
  return Object.freeze({ lizard: null, findings: Object.freeze<RulePackFindingEnrichment[]>([]) });
}

export const SEVERITY_ORDER: Readonly<Record<RulePackFindingEnrichment["severity"], number>> =
  Object.freeze({ error: 0, warning: 1, info: 2 });

/**
 * Read every rule-pack analyzer's persisted findings for a file and
 * fold them into a single array tagged with the analyzer name. Returns
 * null when no analyzer ran on the file.
 */
export function readRulePackFindings(
  state: StateStore,
  fileId: FileId,
): RulePackFindingEnrichment[] | null {
  const out: RulePackFindingEnrichment[] = [];
  let any = false;
  for (const analyzer of ["semgrep", "ast-grep", "quality"]) {
    const row = state.getFileEnrichment(fileId, analyzer);
    if (row === null) continue;
    any = true;
    if (row.status !== "complete" || row.payloadJson === undefined) continue;
    try {
      const parsed = JSON.parse(row.payloadJson) as {
        findings?: ReadonlyArray<{
          ruleId: string;
          severity: RulePackFindingEnrichment["severity"];
          message: string;
          category: string;
          lineFrom: number;
          lineTo: number;
        }>;
      };
      for (const f of parsed.findings ?? []) {
        out.push({
          analyzer,
          ruleId: f.ruleId,
          severity: f.severity,
          message: f.message,
          category: f.category,
          lineFrom: f.lineFrom,
          lineTo: f.lineTo,
        });
      }
    } catch {
      // Malformed payload row: skip but don't kill the whole list —
      // the other analyzer may still have valid findings.
    }
  }
  return any ? out : null;
}

export function filterFindingsForRange(
  findings: ReadonlyArray<RulePackFindingEnrichment>,
  startLine: number,
  endLine: number,
): RulePackFindingEnrichment[] {
  const overlapping = findings.filter((f) => f.lineFrom <= endLine && f.lineTo >= startLine);
  overlapping.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return a.lineFrom - b.lineFrom;
  });
  return overlapping;
}

/**
 * Pull lizard's per-function metrics for a file out of file_enrichments.
 * Returns null when no enrichment exists or the payload is unparseable;
 * empty array means lizard ran but found no functions.
 */
export function readLizardFunctions(
  state: StateStore,
  fileId: FileId,
): LizardEnrichmentMetric[] | null {
  const row = state.getFileEnrichment(fileId, "lizard");
  if (row === null || row.status !== "complete" || row.payloadJson === undefined) return null;
  try {
    const parsed = JSON.parse(row.payloadJson) as {
      functions?: ReadonlyArray<{
        name: string;
        nloc: number;
        ccn: number;
        tokens: number;
        parameters: number;
        lineFrom: number;
        lineTo: number;
      }>;
    };
    return (parsed.functions ?? []).map((f) => ({
      functionName: f.name,
      ccn: f.ccn,
      nloc: f.nloc,
      tokens: f.tokens,
      parameters: f.parameters,
      lineFrom: f.lineFrom,
      lineTo: f.lineTo,
    }));
  } catch {
    return null;
  }
}

/**
 * Among lizard's per-function metrics, pick the one whose line range
 * overlaps the chunk's. When several overlap (chunk spans multiple
 * functions), prefer the one with the largest overlap.
 */
export function pickOverlapping(
  fns: ReadonlyArray<LizardEnrichmentMetric>,
  startLine: number,
  endLine: number,
): LizardEnrichmentMetric | null {
  let best: LizardEnrichmentMetric | null = null;
  let bestOverlap = 0;
  for (const f of fns) {
    const lo = Math.max(f.lineFrom, startLine);
    const hi = Math.min(f.lineTo, endLine);
    const overlap = hi - lo + 1;
    if (overlap > bestOverlap) {
      best = f;
      bestOverlap = overlap;
    }
  }
  return best;
}
