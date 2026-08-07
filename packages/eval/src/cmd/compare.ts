/**
 * `loctx-eval compare <run-a> <run-b>` — pairwise delta table over
 * two run JSONs. Output to stdout; no file written (callers can
 * redirect or pipe).
 */

import { renderCompare } from "../report.js";
// Validated at the read boundary (CLI-11) — a truncated or hand-edited
// run file fails with a pointed message, not a silently 0-filled delta.
import { readRun } from "../run-json.js";
import { resolveRunJson } from "./report.js";

export interface CompareCommandOptions {
  readonly a: string;
  readonly b: string;
}

export function compareCommand(options: CompareCommandOptions): string {
  const a = readRun(resolveRunJson(options.a));
  const b = readRun(resolveRunJson(options.b));
  return renderCompare(a, b);
}
