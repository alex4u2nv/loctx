/**
 * `loctx-eval report <run-dir-or-json>` — read a run JSON, render
 * Markdown, write `report.md` next to the JSON, and echo to stdout.
 *
 * Accepts either an explicit path to a `*.json` file or a directory;
 * the directory form picks the lexically-latest `*.json` (run ids are
 * ISO-ish stamps so this matches "newest"). Either way the report
 * lands next to the source JSON for easy pairing.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport } from "../report.js";
import type { RunResultJson } from "../types.js";

export interface ReportCommandOptions {
  readonly target: string;
}

export interface ReportCommandResult {
  readonly markdownPath: string;
  readonly markdown: string;
}

export function reportCommand(options: ReportCommandOptions): ReportCommandResult {
  const jsonPath = resolveRunJson(options.target);
  const run = JSON.parse(readFileSync(jsonPath, "utf-8")) as RunResultJson;
  const markdown = renderReport(run);
  const markdownPath = jsonPath.replace(/\.json$/, ".report.md");
  writeFileSync(markdownPath, markdown, "utf-8");
  return Object.freeze({ markdownPath, markdown });
}

export function resolveRunJson(target: string): string {
  const stat = statSync(target);
  if (stat.isFile()) return target;
  if (!stat.isDirectory()) {
    throw new Error(`${target}: not a file or directory.`);
  }
  const jsons = readdirSync(target)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const latest = jsons[jsons.length - 1];
  if (latest === undefined) {
    throw new Error(`${target}: no *.json run files found.`);
  }
  return join(target, latest);
}
