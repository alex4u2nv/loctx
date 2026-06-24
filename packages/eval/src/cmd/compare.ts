/**
 * `loctx-eval compare <run-a> <run-b>` — pairwise delta table over
 * two run JSONs. Output to stdout; no file written (callers can
 * redirect or pipe).
 */

import { readFileSync } from "node:fs";
import { renderCompare } from "../report.js";
import type { RunResultJson } from "../types.js";
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

function readRun(path: string): RunResultJson {
  return JSON.parse(readFileSync(path, "utf-8")) as RunResultJson;
}
