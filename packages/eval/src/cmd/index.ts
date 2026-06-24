/**
 * `loctx-eval index <golden-set>` — snapshot the pinned corpus and
 * index it into a temp dataDir. Prints the chunk-boundary digest so
 * authors can sanity-check determinism before running the full eval.
 *
 * Same machinery as `run`, minus the query/score loop. Useful when you
 * want to time the indexer in isolation or inspect the boundary hash
 * without paying for the embedder pass on every query.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSandboxedRuntime, indexCorpus, loadCorpusConfig, snapshotCorpus } from "../corpus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN_ROOT = resolve(HERE, "..", "..", "golden");

export interface IndexCommandOptions {
  readonly goldenSet: string;
  readonly goldenRoot?: string;
}

export interface IndexCommandResult {
  readonly chunkBoundaryHash: string;
  readonly indexedFiles: number;
  readonly chunkCount: number;
}

export async function indexCommand(options: IndexCommandOptions): Promise<IndexCommandResult> {
  const goldenRoot = options.goldenRoot ?? DEFAULT_GOLDEN_ROOT;
  const setDir = join(goldenRoot, options.goldenSet);
  const corpus = loadCorpusConfig(join(setDir, "corpus.toml"));
  const searchRoots = [process.cwd(), resolve(process.cwd(), "..")];
  const snap = await snapshotCorpus(corpus, searchRoots);
  let runtimeBox: Awaited<ReturnType<typeof buildSandboxedRuntime>> | undefined;
  try {
    runtimeBox = await buildSandboxedRuntime(corpus);
    const { runtime } = runtimeBox;
    const { project, chunkBoundaryHash } = await indexCorpus(runtime, snap.root);
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
  } finally {
    if (runtimeBox !== undefined) await runtimeBox.close();
    snap.cleanup();
  }
}
