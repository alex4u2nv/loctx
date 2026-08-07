/**
 * `loctx-eval run <golden-set>` — index the pinned corpus, run every
 * query, score, and emit `<runs>/<runId>.trec` + `<runs>/<runId>.json`.
 *
 * Run id is `YYYYMMDD-HHMMSS-<short loctx sha>` so multiple runs on
 * the same day sort chronologically and you can spot which build a
 * run came from at a glance.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { identityToString } from "@loctx/core";
import type { GoldenSetOptions } from "../corpus.js";
import { goldenSetDir, withCorpusRuntime } from "../corpus.js";
import { scoreRun } from "../metrics.js";
import { loadQrels } from "../qrels.js";
import { runQueries } from "../runner.js";
import { writeTrec } from "../trec.js";
import type { QueryId, QueryType, RankedDoc, RunResultJson } from "../types.js";

const DEFAULT_RUNS_ROOT = resolve(process.cwd(), "runs");

export interface RunCommandOptions extends GoldenSetOptions {
  readonly runsRoot?: string;
}

export async function runCommand(options: RunCommandOptions): Promise<{
  readonly trecPath: string;
  readonly jsonPath: string;
  readonly runId: string;
}> {
  const runsRoot = options.runsRoot ?? DEFAULT_RUNS_ROOT;
  // Load qrels before the (expensive) snapshot + index so an authoring
  // error in the gold set fails fast.
  const qrels = loadQrels(join(goldenSetDir(options), "qrels.jsonl"));
  const startedAt = new Date();

  return withCorpusRuntime(options, async ({ corpus, runtime, project, chunkBoundaryHash }) => {
    const results = await runQueries(runtime.searcher, qrels, { project });
    const perQueryRanked = new Map<QueryId, ReadonlyArray<RankedDoc>>();
    const queryTypes = new Map<QueryId, QueryType>();
    for (const r of results) {
      perQueryRanked.set(r.queryId, r.ranked);
      queryTypes.set(r.queryId, r.queryType);
    }
    const scored = scoreRun(perQueryRanked, qrels, queryTypes);

    const finishedAt = new Date();
    const loctxSha = readLoctxSha();
    const runId = formatRunId(startedAt, loctxSha);
    mkdirSync(runsRoot, { recursive: true });
    const trecPath = join(runsRoot, `${runId}.trec`);
    const jsonPath = join(runsRoot, `${runId}.json`);

    const runJson: RunResultJson = Object.freeze({
      runId,
      goldenSet: options.goldenSet,
      corpusSha: corpus.sha,
      loctxSha,
      embedder: identityToString(runtime.embeddings.identity),
      runtime: `node ${process.version}`,
      chunkingConfig: "default",
      retrievalConfig: `${runtime.config.retrieval.mode}|rrfK=${runtime.config.retrieval.rrfK}`,
      chunkBoundaryHash,
      metrics: {
        overall: scored.overall,
        byQueryType: scored.byQueryType,
      },
      perQuery: scored.perQuery,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    });

    writeTrec(trecPath, results, `loctx-${options.goldenSet}`);
    writeFileSync(jsonPath, `${JSON.stringify(runJson, null, 2)}\n`, "utf-8");

    return Object.freeze({ trecPath, jsonPath, runId });
  });
}

function formatRunId(startedAt: Date, loctxSha: string): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${startedAt.getUTCFullYear()}${pad(startedAt.getUTCMonth() + 1)}${pad(startedAt.getUTCDate())}`;
  const time = `${pad(startedAt.getUTCHours())}${pad(startedAt.getUTCMinutes())}${pad(startedAt.getUTCSeconds())}`;
  return `${date}-${time}-${loctxSha.slice(0, 7)}`;
}

function readLoctxSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}
