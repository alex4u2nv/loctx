/**
 * ast-grep adapter (#64).
 *
 * ast-grep (https://ast-grep.github.io/) runs structural rules against
 * source files and emits per-match JSON. We invoke the binary as an
 * external process; missing binaries are a soft failure.
 *
 * Output parsing
 * --------------
 * `ast-grep scan --json --rule <file_or_dir> <file>` emits an array of
 * matches:
 *
 *   [ { "ruleId": "no-eval",
 *       "severity": "error",
 *       "message": "...",
 *       "metadata": { "category": "security" },
 *       "range": { "start": { "line": N }, "end": { "line": M } } } ]
 *
 * Lines in ast-grep are 0-indexed; we convert to 1-indexed to match
 * the rest of the codebase.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type RulePackFileResult,
  type RulePackFinding,
  capFindings,
  normalizeSeverity,
} from "./rule-pack.js";

export const AST_GREP_VERSION = 1;

const exec = promisify(execFile);

export async function detectAstGrep(command = "ast-grep"): Promise<string | null> {
  try {
    await exec(command, ["--version"], { timeout: 2000 });
    return command;
  } catch {
    return null;
  }
}

export interface RunAstGrepOptions {
  readonly command: string;
  readonly ruleDirs: ReadonlyArray<string>;
  readonly maxFindingsPerFile: number;
  readonly timeoutMs?: number;
}

export async function runAstGrep(
  filePath: string,
  opts: RunAstGrepOptions,
  signal?: AbortSignal,
): Promise<RulePackFileResult> {
  if (opts.ruleDirs.length === 0) {
    return Object.freeze({
      analyzer: "ast-grep",
      toolVersion: "",
      findings: Object.freeze<RulePackFinding[]>([]),
    });
  }
  const args = ["scan", "--json"];
  for (const dir of opts.ruleDirs) {
    args.push("--rule", dir);
  }
  args.push(filePath);
  // `signal` flows from the queue's per-task abort; aborting kills the
  // ast-grep subprocess so a timeout reliably reclaims resources
  // (#197).
  const { stdout } = await exec(opts.command, args, {
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(signal !== undefined ? { signal } : {}),
  });
  return parseAstGrepJson(stdout, opts.maxFindingsPerFile);
}

interface AstGrepMatch {
  ruleId?: unknown;
  rule_id?: unknown;
  severity?: unknown;
  message?: unknown;
  metadata?: { category?: unknown } | unknown;
  range?: {
    start?: { line?: unknown } | unknown;
    end?: { line?: unknown } | unknown;
  };
}

export function parseAstGrepJson(json: string, cap: number): RulePackFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return Object.freeze({
      analyzer: "ast-grep",
      toolVersion: "",
      findings: Object.freeze<RulePackFinding[]>([]),
    });
  }
  const matches: AstGrepMatch[] = Array.isArray(parsed)
    ? (parsed as AstGrepMatch[])
    : Array.isArray((parsed as { matches?: unknown }).matches)
      ? (parsed as { matches: AstGrepMatch[] }).matches
      : [];
  const out: RulePackFinding[] = [];
  for (const m of matches) {
    const ruleId =
      typeof m.ruleId === "string" ? m.ruleId : typeof m.rule_id === "string" ? m.rule_id : "";
    if (ruleId === "") continue;
    const range = m.range;
    if (range === undefined) continue;
    const lineFrom = readLine(range.start);
    const lineTo = readLine(range.end);
    if (lineFrom === null || lineTo === null) continue;
    const message = typeof m.message === "string" ? m.message : "";
    const severity = normalizeSeverity(m.severity);
    const meta = (m.metadata ?? {}) as { category?: unknown };
    const category = typeof meta.category === "string" ? meta.category : "";
    // ast-grep reports 0-indexed lines; bump to 1-indexed for parity
    // with the rest of the codebase (lizard, duplicates, FTS).
    out.push(
      Object.freeze({
        ruleId,
        severity,
        message,
        category,
        lineFrom: lineFrom + 1,
        lineTo: lineTo + 1,
      }),
    );
  }
  return Object.freeze({
    analyzer: "ast-grep",
    toolVersion: "",
    findings: Object.freeze(capFindings(out, cap)),
  });
}

function readLine(node: unknown): number | null {
  if (typeof node === "object" && node !== null) {
    const v = (node as { line?: unknown }).line;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}
