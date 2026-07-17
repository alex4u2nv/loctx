/**
 * Query runner. Walks the gold-set queries, executes each through
 * `WorkspaceSearcher`, and maps results to `(rel_path, start_line,
 * end_line)` docids so the scorer can apply span-overlap matching.
 */

import type { Project, Runtime, WorkspaceSearcher } from "@loctx/core";
import { groupQrelsByQuery } from "./qrels.js";
import type { Qrel, QueryRunResult, RankedDoc } from "./types.js";
import { queryId } from "./types.js";

/** How many candidates the runner fetches per query. */
export const DEFAULT_FETCH_K = 50;

export interface RunOptions {
  readonly fetchK?: number;
  /** Scope every query to a project. Defaults to all-projects search. */
  readonly project?: Project;
}

/**
 * Execute every unique query in the qrels set against the searcher.
 * Returns one `QueryRunResult` per queryId in deterministic
 * (qrels insertion) order so the TREC + run JSON outputs are
 * byte-stable across invocations.
 */
export async function runQueries(
  searcher: WorkspaceSearcher,
  qrels: ReadonlyArray<Qrel>,
  options: RunOptions = {},
): Promise<ReadonlyArray<QueryRunResult>> {
  const grouped = groupQrelsByQuery(qrels);
  const limit = Math.max(1, options.fetchK ?? DEFAULT_FETCH_K);
  const results: QueryRunResult[] = [];

  // Queries run serially, each embedding its own query text inside
  // searcher.search(). Fine today — the harness forces the deterministic
  // fake provider (no network, negligible cost) — but this loop would
  // dominate wall-clock against a real embedder. When the real-embedder
  // flag lands, batch-embed the unique query texts once before the loop
  // and pass the vectors in, instead of one embedQuery per query (#471).
  for (const [qid, queryQrels] of grouped) {
    const first = queryQrels[0];
    if (first === undefined) continue;
    const response = await searcher.search({
      query: first.query,
      limit,
      ...(options.project !== undefined ? { path: options.project.root } : {}),
    });
    const ranked: RankedDoc[] = response.results.map((r, i) =>
      Object.freeze<RankedDoc>({
        relPath: r.relPath,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        rank: i + 1,
      }),
    );
    results.push(
      Object.freeze<QueryRunResult>({
        queryId: queryId(qid),
        query: first.query,
        queryType: first.queryType,
        ranked: Object.freeze(ranked),
      }),
    );
  }
  return Object.freeze(results);
}

/**
 * Pair the runtime + project context up with the searcher. Callers in
 * `cmd/run.ts` use this to keep the search loop hermetic — every
 * dependency (searcher, project) is passed in explicitly.
 */
export function searcherFor(runtime: Runtime): WorkspaceSearcher {
  return runtime.searcher;
}
