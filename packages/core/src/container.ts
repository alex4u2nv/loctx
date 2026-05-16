/**
 * Composition root: wire dependencies for the CLI and (later) MCP server.
 *
 * The embedding provider is selected by `config.embedding.providerOverride`
 * (sourced from `LOCTX_EMBEDDING_PROVIDER` at `loadConfig` time):
 *   - `"fake"` → FakeEmbeddingProvider (deterministic SHA-based vectors, no
 *               model download). Intended for tests and quick smoke runs.
 *   - else    → LocalEmbeddingProvider via @huggingface/transformers.
 *
 * Reading the override from `Config` (not `process.env`) keeps `buildRuntime`
 * deterministic from a `Config` snapshot.
 */

import { readFileSync } from "node:fs";
import {
  AST_GREP_VERSION,
  DUPLICATES_VERSION,
  EnrichmentQueue,
  LIZARD_VERSION,
  SEMGREP_VERSION,
  computeDuplicateWindows,
  runAstGrep,
  runLizard,
  runSemgrep,
} from "./analyzers/index.js";
import type { Config } from "./config.js";
import { DEFAULT_PROJECT_MARKERS, type MarkerSpec, WorkspaceDiscovery } from "./discovery.js";
import {
  type EmbeddingProvider,
  FakeEmbeddingProvider,
  LocalEmbeddingProvider,
} from "./embeddings/index.js";
import { type FilteringRules, ProjectFilter, loadFilteringRules } from "./filtering.js";
import { combinedGitignore } from "./gitignore.js";
import { ProjectIndexer, Reconciler } from "./indexing/index.js";
import type { Project } from "./models.js";
import { WorkspaceSearcher } from "./retrieval/index.js";
import { StateStore, type VectorStore, createVectorStore } from "./storage/index.js";

export interface Runtime {
  readonly config: Config;
  readonly state: StateStore;
  readonly vectors: VectorStore;
  readonly embeddings: EmbeddingProvider;
  readonly discovery: WorkspaceDiscovery;
  readonly rules: FilteringRules;
  readonly indexer: ProjectIndexer;
  readonly reconciler: Reconciler;
  readonly searcher: WorkspaceSearcher;
  readonly enrichments: EnrichmentQueue;
  /**
   * Release every resource the runtime owns. Awaitable so callers can
   * sequence shutdown (watcher → web → runtime). The embedding provider's
   * optional `dispose()` runs first because ONNX session teardown is the
   * slowest step.
   */
  close(): Promise<void>;
}

export async function buildRuntime(config: Config): Promise<Runtime> {
  const rules = loadFilteringRules();
  const state = new StateStore(config.paths.stateDb);
  const embeddings = createEmbeddings(config);
  // Lazy providers (Local) need a warmup; in-process providers (Fake) skip it.
  await embeddings.ensureReady?.();
  const vectors = createVectorStore(config.paths.vectorDir, embeddings.identity, state);
  const extraMarkers: MarkerSpec[] = config.discovery.extraMarkers.map((name) => ({
    name,
    kind: "file" as const,
    group: "build" as const,
  }));
  const discovery = new WorkspaceDiscovery(config.workspaceRoots, {
    maxDepth: config.discovery.maxDepth,
    markers:
      extraMarkers.length === 0
        ? DEFAULT_PROJECT_MARKERS
        : [...DEFAULT_PROJECT_MARKERS, ...extraMarkers],
  });

  const filterFor = (project: Project): ProjectFilter =>
    new ProjectFilter(project, rules, combinedGitignore(project.root));

  // Background analyzer queue + persistence sink. Each completion writes
  // to file_enrichments so reconciliation / status / search can read it.
  const enrichments = new EnrichmentQueue({
    concurrency: config.analyzers.concurrency,
    perTaskTimeoutMs: config.analyzers.perTaskTimeoutMs,
    onResult: (r) => {
      const meta = r.task as ReturnType<typeof analyzerTaskMeta>;
      state.upsertFileEnrichment({
        fileId: meta.fileId,
        analyzer: meta.analyzer,
        analyzerVersion: meta.analyzerVersion,
        contentSha: meta.contentSha,
        status: r.status === "complete" ? "complete" : "failed",
        ...(r.payload !== undefined ? { payloadJson: JSON.stringify(r.payload) } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
        enqueuedAt: r.enqueuedAt,
        completedAt: r.completedAt,
      });
    },
  });

  const indexer = new ProjectIndexer(state, vectors, embeddings, filterFor, {
    afterFileIndexed: ({ project, fileId, absPath, contentSha }) => {
      if (!config.analyzers.backgroundEnabled) return;
      if (config.analyzers.lizard.enabled) {
        const command = config.analyzers.lizard.command;
        enrichments.enqueue(
          analyzerTaskMeta({
            fileId,
            project,
            analyzer: "lizard",
            analyzerVersion: LIZARD_VERSION,
            contentSha,
            run: (signal) => runLizard(command, absPath, signal),
          }),
        );
      }
      if (config.analyzers.duplicates.enabled) {
        const dupOpts = {
          windowSize: config.analyzers.duplicates.windowSize,
          minUniqueTokens: config.analyzers.duplicates.minUniqueTokens,
        };
        enrichments.enqueue(
          analyzerTaskMeta({
            fileId,
            project,
            analyzer: "duplicates",
            analyzerVersion: DUPLICATES_VERSION,
            contentSha,
            // Read off-thread is fine; duplicates is a CPU-only pass over
            // the file body and the queue caps concurrency.
            run: async () => computeDuplicateWindows(readFileSync(absPath, "utf-8"), dupOpts),
          }),
        );
      }
      if (config.analyzers.semgrep.enabled && config.analyzers.semgrep.ruleDirs.length > 0) {
        const sg = config.analyzers.semgrep;
        enrichments.enqueue(
          analyzerTaskMeta({
            fileId,
            project,
            analyzer: "semgrep",
            analyzerVersion: SEMGREP_VERSION,
            contentSha,
            run: (signal) =>
              runSemgrep(
                absPath,
                {
                  command: sg.command,
                  ruleDirs: sg.ruleDirs,
                  maxFindingsPerFile: sg.maxFindingsPerFile,
                },
                signal,
              ),
          }),
        );
      }
      if (config.analyzers.astGrep.enabled && config.analyzers.astGrep.ruleDirs.length > 0) {
        const ag = config.analyzers.astGrep;
        enrichments.enqueue(
          analyzerTaskMeta({
            fileId,
            project,
            analyzer: "ast-grep",
            analyzerVersion: AST_GREP_VERSION,
            contentSha,
            run: (signal) =>
              runAstGrep(
                absPath,
                {
                  command: ag.command,
                  ruleDirs: ag.ruleDirs,
                  maxFindingsPerFile: ag.maxFindingsPerFile,
                },
                signal,
              ),
          }),
        );
      }
    },
  });
  const reconciler = new Reconciler(state, indexer);
  const searcher = new WorkspaceSearcher(vectors, embeddings, discovery, state, config.retrieval);

  return Object.freeze({
    config,
    state,
    vectors,
    embeddings,
    discovery,
    rules,
    indexer,
    reconciler,
    searcher,
    enrichments,
    close: async () => {
      await embeddings.dispose?.();
      state.close();
    },
  });
}

/**
 * Build an EnrichmentTask whose id encodes (analyzer, fileId) so the
 * queue dedupes per-file-per-analyzer correctly. Carries fileId on the
 * object literal so the result sink can write back to file_enrichments
 * without needing to parse the id.
 */
function analyzerTaskMeta(input: {
  fileId: import("./models.js").FileId;
  project: Project;
  analyzer: string;
  analyzerVersion: number;
  contentSha: string;
  run: (signal?: AbortSignal) => Promise<unknown>;
}) {
  return {
    id: `${input.analyzer}:${input.fileId}`,
    analyzer: input.analyzer,
    analyzerVersion: input.analyzerVersion,
    contentSha: input.contentSha,
    fileId: input.fileId,
    project: input.project,
    run: input.run,
  };
}

function createEmbeddings(config: Config): EmbeddingProvider {
  if (config.embedding.providerOverride === "fake") {
    return new FakeEmbeddingProvider({ dimension: 16, normalize: config.embedding.normalize });
  }
  return new LocalEmbeddingProvider({
    modelName: config.embedding.model,
    normalize: config.embedding.normalize,
    // Pass the data dir so ensureReady() can consult the trusted-models
    // store and skip the network gate for explicitly-downloaded models.
    dataDir: config.paths.dataDir,
  });
}
