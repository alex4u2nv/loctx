/**
 * Shared finding shape for rule-pack analyzers (Semgrep, ast-grep) (#64).
 *
 * Both tools emit per-file matches against a configured rule set; we
 * normalise their JSON outputs into the same `RulePackFinding` so the
 * search-result surface and storage layer don't need to know which
 * binary produced a hit.
 */

import { execFileAsync as exec } from "../proc.js";

/**
 * Probe an external analyzer binary by running `<command> --version`
 * (CORE-8 — the lizard/semgrep/ast-grep detectors were three copies of
 * this differing only in timeout). Returns the command when it responds
 * within `timeoutMs`, null when it is missing or unresponsive.
 */
export async function detectCommand(command: string, timeoutMs: number): Promise<string | null> {
  try {
    await exec(command, ["--version"], { timeout: timeoutMs });
    return command;
  } catch {
    return null;
  }
}

export interface RulePackFinding {
  /** Stable rule identifier as reported by the tool (e.g. `python.lang.security.audit.exec-detected`). */
  readonly ruleId: string;
  /** Severity bucket. We collapse vendor-specific levels to a small enum. */
  readonly severity: "error" | "warning" | "info";
  /** Human-readable message. May be empty if the rule omitted one. */
  readonly message: string;
  /** Optional category/tag (e.g. `security`, `correctness`). Empty when missing. */
  readonly category: string;
  /** First line of the match, 1-indexed. */
  readonly lineFrom: number;
  /** Last line of the match, 1-indexed and inclusive. */
  readonly lineTo: number;
}

export interface RulePackFileResult {
  /** Originating analyzer name (`semgrep` | `ast-grep`). */
  readonly analyzer: string;
  /** Tool version string at run time, when reported. Empty if unknown. */
  readonly toolVersion: string;
  /** Findings in source order, capped by `maxFindingsPerFile`. */
  readonly findings: ReadonlyArray<RulePackFinding>;
}

const SEVERITY_MAP: Readonly<Record<string, RulePackFinding["severity"]>> = Object.freeze({
  error: "error",
  ERROR: "error",
  high: "error",
  HIGH: "error",
  critical: "error",
  CRITICAL: "error",
  warning: "warning",
  WARNING: "warning",
  medium: "warning",
  MEDIUM: "warning",
  info: "info",
  INFO: "info",
  low: "info",
  LOW: "info",
  hint: "info",
  HINT: "info",
});

export function normalizeSeverity(raw: unknown): RulePackFinding["severity"] {
  if (typeof raw !== "string") return "info";
  return SEVERITY_MAP[raw] ?? "info";
}

export function capFindings(
  findings: ReadonlyArray<RulePackFinding>,
  cap: number,
): ReadonlyArray<RulePackFinding> {
  if (cap <= 0 || findings.length <= cap) return findings;
  return findings.slice(0, cap);
}
