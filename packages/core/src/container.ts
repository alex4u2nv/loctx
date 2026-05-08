/**
 * Composition root: wire dependencies for the CLI and (later) MCP server.
 */

import type { Config } from "./config.js";
import { WorkspaceDiscovery } from "./discovery.js";
import { LocalEmbeddingProvider } from "./embeddings/index.js";
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
  readonly embeddings: LocalEmbeddingProvider;
  readonly discovery: WorkspaceDiscovery;
  readonly rules: FilteringRules;
  readonly indexer: ProjectIndexer;
  readonly searcher: WorkspaceSearcher;
  close(): void;
}

export async function buildRuntime(config: Config): Promise<Runtime> {
  const rules = loadFilteringRules();
  const state = new StateStore(config.paths.stateDb);
  const embeddings = new LocalEmbeddingProvider({
    modelName: config.embedding.model,
    normalize: config.embedding.normalize,
  });
  // Force model load up front so identity is known when constructing VectorStore.
  await embeddings.ensureReady();
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
