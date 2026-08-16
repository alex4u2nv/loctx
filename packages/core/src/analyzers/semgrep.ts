/**
 * Semgrep CE adapter (#64).
 *
 * Semgrep (https://github.com/semgrep/semgrep) scans files against a
 * rule pack and emits structured JSON. We invoke it as an external
 * process and run it only through the background enrichment queue;
 * missing binaries are a soft failure (returns `null` from `detect`).
 *
 * Output parsing
 * --------------
 * `semgrep --json --quiet --metrics=off --error --config <dir> <file>`
 * yields:
 *
 *   { "results": [
 *       { "check_id": "...", "path": "...",
 *         "start": { "line": N }, "end": { "line": M },
 *         "extra": { "message": "...", "severity": "ERROR",
 *                    "metadata": { "category": "security" } } } ],
 *     "version": "1.x.y" }
 *
 * We tolerate older shapes: missing metadata, alternative severity
 * names, `start_line`/`end_line` instead of nested `start.line`.
 */

import { execFileAsync as exec } from "../proc.js";
import {
  capFindings,
  detectCommand,
  normalizeSeverity,
  type RulePackFileResult,
  type RulePackFinding,
} from "./rule-pack.js";

export const SEMGREP_VERSION = 1;

export async function detectSemgrep(command = "semgrep"): Promise<string | null> {
  // semgrep is a heavy Python app; `--version` cold-starts the
  // interpreter + a large dependency tree and the first run after
  // install does extra setup, routinely exceeding a 2s budget. A
  // generous timeout here only slows the (rare) detection path, not
  // the hot enrichment path — and a too-tight one made a working
  // install report "not installed".
  return detectCommand(command, 15_000);
}

export interface RunSemgrepOptions {
  readonly command: string;
  readonly ruleDirs: ReadonlyArray<string>;
  /**
   * Registry fallback (e.g. `p/default`) used when `ruleDirs` is empty, so
   * semgrep produces findings with zero local config. Blank = no fallback.
   */
  readonly registryConfig?: string;
  readonly maxFindingsPerFile: number;
  readonly timeoutMs?: number;
}

export async function runSemgrep(
  filePath: string,
  opts: RunSemgrepOptions,
  signal?: AbortSignal,
): Promise<RulePackFileResult> {
  // Use explicit rule dirs when configured; otherwise fall back to the
  // registry pack (curated community rules) so "installed, no rules" still
  // produces findings. Only inert when both are empty.
  const configs =
    opts.ruleDirs.length > 0 ? opts.ruleDirs : opts.registryConfig ? [opts.registryConfig] : [];
  if (configs.length === 0) {
    return Object.freeze({
      analyzer: "semgrep",
      toolVersion: "",
      findings: Object.freeze<RulePackFinding[]>([]),
    });
  }
  const args = ["--json", "--quiet", "--metrics=off"];
  for (const cfg of configs) {
    args.push("--config", cfg);
  }
  args.push(filePath);
  // `signal` wires the queue's per-task abort through to the child
  // process so a timeout actually kills semgrep instead of letting it
  // keep running off-thread (#197).
  const { stdout } = await exec(opts.command, args, {
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(signal !== undefined ? { signal } : {}),
  });
  return parseSemgrepJson(stdout, opts.maxFindingsPerFile);
}

interface SemgrepJsonResult {
  check_id?: unknown;
  start?: { line?: unknown } | unknown;
  end?: { line?: unknown } | unknown;
  start_line?: unknown;
  end_line?: unknown;
  extra?: {
    message?: unknown;
    severity?: unknown;
    metadata?: { category?: unknown } | unknown;
  };
}

interface SemgrepJsonOutput {
  results?: ReadonlyArray<SemgrepJsonResult>;
  version?: unknown;
}

export function parseSemgrepJson(json: string, cap: number): RulePackFileResult {
  let parsed: SemgrepJsonOutput;
  try {
    parsed = JSON.parse(json) as SemgrepJsonOutput;
  } catch {
    return Object.freeze({
      analyzer: "semgrep",
      toolVersion: "",
      findings: Object.freeze<RulePackFinding[]>([]),
    });
  }
  const toolVersion = typeof parsed.version === "string" ? parsed.version : "";
  const out: RulePackFinding[] = [];
  for (const r of parsed.results ?? []) {
    const ruleId = typeof r.check_id === "string" ? r.check_id : "";
    if (ruleId === "") continue;
    const lineFrom = pickLine(r.start, r.start_line);
    const lineTo = pickLine(r.end, r.end_line);
    if (lineFrom === null || lineTo === null) continue;
    const extra = (r.extra ?? {}) as {
      message?: unknown;
      severity?: unknown;
      metadata?: unknown;
    };
    const message = typeof extra.message === "string" ? extra.message : "";
    const severity = normalizeSeverity(extra.severity);
    const meta = (extra.metadata ?? {}) as { category?: unknown };
    const category = typeof meta.category === "string" ? meta.category : "";
    out.push(Object.freeze({ ruleId, severity, message, category, lineFrom, lineTo }));
  }
  return Object.freeze({
    analyzer: "semgrep",
    toolVersion,
    findings: Object.freeze(capFindings(out, cap)),
  });
}

function pickLine(nested: unknown, flat: unknown): number | null {
  if (typeof nested === "object" && nested !== null) {
    const v = (nested as { line?: unknown }).line;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  if (typeof flat === "number" && Number.isFinite(flat)) return flat;
  return null;
}
