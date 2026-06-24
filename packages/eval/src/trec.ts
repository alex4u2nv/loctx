/**
 * TREC run-file writer.
 *
 * Format (one ranked doc per line, space-separated):
 *
 *   <query_id> Q0 <docid> <rank> <score> <run_tag>
 *
 * docid is `relPath:startLine-endLine` so external tools using
 * pytrec_eval or ir-measures can re-verify our in-process metrics
 * against the same span-based scheme our qrels use.
 */

import { writeFileSync } from "node:fs";
import type { QueryRunResult } from "./types.js";

export function docidFor(relPath: string, startLine: number, endLine: number): string {
  return `${relPath}:${startLine}-${endLine}`;
}

export function formatTrec(results: ReadonlyArray<QueryRunResult>, runTag: string): string {
  const lines: string[] = [];
  for (const r of results) {
    for (const doc of r.ranked) {
      lines.push(
        `${r.queryId} Q0 ${docidFor(doc.relPath, doc.startLine, doc.endLine)} ${doc.rank} ${doc.score.toFixed(6)} ${runTag}`,
      );
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function writeTrec(
  path: string,
  results: ReadonlyArray<QueryRunResult>,
  runTag: string,
): void {
  writeFileSync(path, formatTrec(results, runTag), "utf-8");
}
