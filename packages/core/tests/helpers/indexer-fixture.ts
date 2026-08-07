/**
 * Shared indexer test fixture (TEST-1). The ~25-line beforeEach scaffold
 * (tmp project + .git marker + StateStore + FakeEmbeddingProvider +
 * vector store + ProjectIndexer) had been copy-pasted into four unit
 * tests — found by loctx's own find_duplicates over its index.
 *
 * Layout it creates under a fresh tmp dir:
 *   <tmp>/demo/            — project root ("demo"), with src/ and a
 *                            .git/HEAD marker
 *   <tmp>/.data/           — state.sqlite3 + vectors/
 *
 * Tests add their own files/dirs on top and call `cleanup()` in
 * afterEach.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeEmbeddingProvider } from "../../src/embeddings/index.js";
import { loadFilteringRules, ProjectFilter } from "../../src/filtering.js";
import { combinedGitignore } from "../../src/gitignore.js";
import { ProjectIndexer } from "../../src/indexing/indexer.js";
import { type Project, projectId } from "../../src/models.js";
import { createVectorStore, StateStore, type VectorStore } from "../../src/storage/index.js";
import { mkTmpDir, rmTmpDir } from "./tmp.js";

export interface IndexerFixture {
  readonly tmp: string;
  readonly projectRoot: string;
  readonly dataDir: string;
  readonly state: StateStore;
  readonly vectors: VectorStore;
  readonly indexer: ProjectIndexer;
  /** Frozen Project over `projectRoot`. Defaults to id "demo-1", name "demo". */
  readonly project: (id?: string, name?: string) => Project;
  /** Close the StateStore and delete the tmp tree. Call in afterEach. */
  readonly cleanup: () => void;
}

export async function makeIndexerFixture(prefix: string): Promise<IndexerFixture> {
  const tmp = mkTmpDir(prefix);
  const projectRoot = join(tmp, "demo");
  const dataDir = join(tmp, ".data");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(dataDir, { recursive: true });

  const state = new StateStore(join(dataDir, "state.sqlite3"));
  const embeddings = new FakeEmbeddingProvider({ dimension: 8, normalize: true });
  await embeddings.ensureReady?.();
  const vectors = createVectorStore(join(dataDir, "vectors"), embeddings.identity, state);
  const rules = loadFilteringRules();
  const indexer = new ProjectIndexer(
    state,
    vectors,
    embeddings,
    (p: Project) => new ProjectFilter(p, rules, combinedGitignore(p.root)),
  );

  return {
    tmp,
    projectRoot,
    dataDir,
    state,
    vectors,
    indexer,
    project: (id = "demo-1", name = "demo") =>
      Object.freeze({ id: projectId(id), name, root: projectRoot }),
    cleanup: () => {
      state.close();
      rmTmpDir(tmp);
    },
  };
}
