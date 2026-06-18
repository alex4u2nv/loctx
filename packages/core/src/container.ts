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
  computeDuplicateWindows,
  DUPLICATES_VERSION,
  detectAstGrep,
  detectLizard,
  detectSemgrep,
  EnrichmentQueue,
  LIZARD_VERSION,
  runAstGrep,
  runLizard,
  runSemgrep,
  SEMGREP_VERSION,
} from "./analyzers/index.js";
import type { Config } from "./config.js";
import { DEFAULT_PROJECT_MARKERS, type MarkerSpec, WorkspaceDiscovery } from "./discovery.js";
import {
  type EmbeddingProvider,
  FakeEmbeddingProvider,
  LocalEmbeddingProvider,
} from "./embeddings/index.js";
import { type FilteringRules, loadFilteringRules, ProjectFilter } from "./filtering.js";
import { combinedGitignore } from "./gitignore.js";
import { ProjectIndexer, Reconciler } from "./indexing/index.js";
import type { Project } from "./models.js";
import { WorkspaceSearcher } from "./retrieval/index.js";
import { createVectorStore, StateStore, type VectorStore } from "./storage/index.js";

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

/**
 * Memoized availability of an external analyzer binary (lizard, semgrep,
 * ast-grep), keyed by command. External analyzers ship enabled by default
 * (#defaults), so without this an absent binary would enqueue a failing
 * task for every indexed file. We probe each command once:
 *   - eagerly in {@link buildRuntime} for the analyzers enabled at boot,
 *     so the first indexed file already knows the answer; and
 *   - lazily from the index hook when an analyzer is enabled later via
 *     hot-reloaded config (applies to files indexed after that point;
 *     rebuild to backfill already-indexed files).
 * Unknown (probe in flight) returns false so we skip rather than fail.
 */
const toolAvailability = new Map<string, boolean>();
const toolProbing = new Set<string>();
const TOOL_DETECTORS: Record<string, (command: string) => Promise<string | null>> = {
  lizard: detectLizard,
  semgrep: detectSemgrep,
  "ast-grep": detectAstGrep,
};

async function probeTool(kind: string, command: string): Promise<boolean> {
  const found = (await TOOL_DETECTORS[kind]?.(command)) ?? null;
  toolAvailability.set(command, found !== null);
  if (found === null) {
    console.error(
      `[loctx analyzers] '${command}' (${kind}) not found on PATH; skipping until installed.`,
    );
  }
  return found !== null;
}

function toolReady(kind: string, command: string): boolean {
  const cached = toolAvailability.get(command);
  if (cached !== undefined) return cached;
  if (!toolProbing.has(command)) {
    toolProbing.add(command);
    void probeTool(kind, command).finally(() => toolProbing.delete(command));
  }
  return false; // probe in flight — skip this round
}

export async function buildRuntime(config: Config): Promise<Runtime> {
  const rules = loadFilteringRules();
  const state = new StateStore(config.paths.stateDb);
  const embeddings = createEmbeddings(config);

  // Probe the external analyzers enabled at boot so the first indexed file
  // already knows whether to enqueue (avoids the initial-index race where
  // many files would skip before a lazy probe resolves).
  if (config.analyzers.backgroundEnabled) {
    await Promise.all([
      config.analyzers.lizard.enabled ? probeTool("lizard", config.analyzers.lizard.command) : null,
      config.analyzers.semgrep.enabled
        ? probeTool("semgrep", config.analyzers.semgrep.command)
        : null,
      config.analyzers.astGrep.enabled
        ? probeTool("ast-grep", config.analyzers.astGrep.command)
        : null,
    ]);
  }
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
      if (config.analyzers.lizard.enabled && toolReady("lizard", config.analyzers.lizard.command)) {
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
      if (
        config.analyzers.semgrep.enabled &&
        config.analyzers.semgrep.ruleDirs.length > 0 &&
        toolReady("semgrep", config.analyzers.semgrep.command)
      ) {
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
      if (
        config.analyzers.astGrep.enabled &&
        config.analyzers.astGrep.ruleDirs.length > 0 &&
        toolReady("ast-grep", config.analyzers.astGrep.command)
      ) {
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
