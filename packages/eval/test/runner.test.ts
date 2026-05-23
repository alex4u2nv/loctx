/**
 * Integration smoke for the runner: we don't spin up a real LanceDB
 * index here (the corpus end-to-end happens through `eval run v1`),
 * but we do drive the runner against a fake searcher so the contract
 * — query order, ranked-doc shape, queryId pass-through — is locked.
 */

import type { WorkspaceSearcher } from "@loctx/core";
import { describe, expect, it } from "vitest";
import { parseQrels } from "../src/qrels.js";
import { runQueries } from "../src/runner.js";
import type { QueryRunResult } from "../src/types.js";

function fakeSearcher(
  responses: ReadonlyMap<
    string,
    ReadonlyArray<{ relPath: string; startLine: number; endLine: number; score: number }>
  >,
): WorkspaceSearcher {
  return {
    async search(request: { query: string }) {
      const results = responses.get(request.query) ?? [];
      return Object.freeze({
        resolvedScope: Object.freeze({
          mode: "all" as const,
          project: null,
          relPrefix: null,
          inputPath: null,
        }),
        results: results.map((r) =>
          Object.freeze({
            projectId: "p",
            projectName: "n",
            projectRoot: null,
            relPath: r.relPath,
            absPath: null,
            startLine: r.startLine,
            endLine: r.endLine,
            score: r.score,
            snippet: "",
            language: "",
            kind: "",
            symbols: Object.freeze<string[]>([]),
            sources: Object.freeze<("vector" | "lexical")[]>([]),
            analyzer: null,
            matchReasons: Object.freeze<never[]>([]),
            coverageReason: null,
            enrichments: Object.freeze({
              lizard: null,
              findings: Object.freeze<never[]>([]),
            }),
          }),
        ),
        warnings: Object.freeze<string[]>([]),
      });
    },
  } as unknown as WorkspaceSearcher;
}

describe("runQueries", () => {
  it("emits one result per unique queryId with 1-based ranks", async () => {
    const qrels = parseQrels(`
{"query_id":"q1","query":"foo","query_type":"literal","rel_path":"a","start_line":1,"end_line":5,"relevance":2,"provenance":"manual"}
{"query_id":"q1","query":"foo","query_type":"literal","rel_path":"b","start_line":1,"end_line":5,"relevance":1,"provenance":"manual"}
{"query_id":"q2","query":"bar","query_type":"concept","rel_path":"c","start_line":1,"end_line":5,"relevance":1,"provenance":"manual"}
`);
    const searcher = fakeSearcher(
      new Map([
        [
          "foo",
          [
            { relPath: "a", startLine: 1, endLine: 5, score: 0.9 },
            { relPath: "b", startLine: 1, endLine: 5, score: 0.5 },
          ],
        ],
        ["bar", [{ relPath: "c", startLine: 1, endLine: 5, score: 0.7 }]],
      ]),
    );
    const out: ReadonlyArray<QueryRunResult> = await runQueries(searcher, qrels);
    expect(out).toHaveLength(2);
    expect(out[0]?.queryId).toBe("q1");
    expect(out[0]?.ranked[0]?.rank).toBe(1);
    expect(out[0]?.ranked[1]?.rank).toBe(2);
    expect(out[1]?.queryId).toBe("q2");
    expect(out[1]?.queryType).toBe("concept");
  });
});
