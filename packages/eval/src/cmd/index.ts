/**
 * `loctx-eval index <golden-set>` — snapshot the pinned corpus and
 * index it into a temp dataDir. Prints the chunk-boundary digest so
 * authors can sanity-check determinism before running the full eval.
 *
 * Same machinery as `run`, minus the query/score loop. Useful when you
 * want to time the indexer in isolation or inspect the boundary hash
 * without paying for the embedder pass on every query.
 */

import type { GoldenSetOptions } from "../corpus.js";
import { withCorpusRuntime } from "../corpus.js";

export type IndexCommandOptions = GoldenSetOptions;

export interface IndexCommandResult {
  readonly chunkBoundaryHash: string;
  readonly indexedFiles: number;
  readonly chunkCount: number;
}

export async function indexCommand(options: IndexCommandOptions): Promise<IndexCommandResult> {
  return withCorpusRuntime(options, async ({ runtime, project, chunkBoundaryHash }) => {
    const files = runtime.state.listFiles(project.id);
    let chunkCount = 0;
    for (const f of files) {
      chunkCount += runtime.state.listChunks(f.fileId).length;
    }
    return Object.freeze({
      chunkBoundaryHash,
      indexedFiles: files.length,
      chunkCount,
    });
  });
}
