/**
 * Composition root: wire dependencies for the CLI and (later) MCP server.
 *
 * The embedding provider is selected via the `LOCTX_EMBEDDING_PROVIDER` env
 * var:
 *   - `fake`  → FakeEmbeddingProvider (deterministic SHA-based vectors,
 *               no model download). Intended for tests and quick smoke runs.
 *   - default → LocalEmbeddingProvider via @huggingface/transformers.
 */

import type { Config } from "./config.js";
import { WorkspaceDiscovery } from "./discovery.js";
import {
  type EmbeddingProvider,
  FakeEmbeddingProvider,
  LocalEmbeddingProvider,
} from "./embeddings/index.js";
import { type FilteringRules, ProjectFilter, loadFilteringRules } from "./filtering.js";
import { combinedGitignore } from "./gitignore.js";
import { ProjectIndexer } from "./indexing/index.js";
import type { Project } from "./models.js";
import { WorkspaceSearcher } from "./retrieval/index.js";
import { StateStore, VectorStore } from "./storage/index.js";

export interface Runtime {
  readonly config: Config;
  readonly state: StateStore;
  readonly vectors: VectorStore;
  readonly embeddings: EmbeddingProvider;
  readonly discovery: WorkspaceDiscovery;
  readonly rules: FilteringRules;
  readonly indexer: ProjectIndexer;
  readonly searcher: WorkspaceSearcher;
  close(): void;
}

export async function buildRuntime(config: Config): Promise<Runtime> {
  const rules = loadFilteringRules();
  const state = new StateStore(config.paths.stateDb);
  const embeddings = createEmbeddings(config);
  // Lazy providers (Local) need a warmup; in-process providers (Fake) skip it.
  await embeddings.ensureReady?.();
  const vectors = new VectorStore(config.paths.chromaDir, embeddings.identity, state);
  const discovery = new WorkspaceDiscovery(config.workspaceRoots);

  const filterFor = (project: Project): ProjectFilter =>
    new ProjectFilter(project, rules, combinedGitignore(project.root));

  const indexer = new ProjectIndexer(state, vectors, embeddings, filterFor);
  const searcher = new WorkspaceSearcher(vectors, embeddings, discovery);

  return Object.freeze({
    config,
    state,
    vectors,
    embeddings,
    discovery,
    rules,
    indexer,
    searcher,
    close: () => state.close(),
  });
}

function createEmbeddings(config: Config): EmbeddingProvider {
  const override = process.env["LOCTX_EMBEDDING_PROVIDER"];
  if (override === "fake") {
    return new FakeEmbeddingProvider({ dimension: 16, normalize: config.embedding.normalize });
  }
  return new LocalEmbeddingProvider({
    modelName: config.embedding.model,
    normalize: config.embedding.normalize,
  });
}
