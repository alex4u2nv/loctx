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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AST_GREP_VERSION,
  bundledAstGrepRulesDir,
  computeDuplicateWindows,
  DEFINITIONS_VERSION,
  DUPLICATES_VERSION,
  detectAstGrep,
  detectLizard,
  detectSemgrep,
  EnrichmentQueue,
  LIZARD_VERSION,
  matchesDefinitionGlobs,
  resolveDefinitionSchemas,
  runAstGrep,
  runDefinitions,
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
import type { FileId, Project } from "./models.js";
import { applyNetworkSettings } from "./network.js";
import { WorkspaceSearcher } from "./retrieval/index.js";
import { createVectorStore, StateStore, type VectorStore } from "./storage/index.js";

/**
 * Live state of the background maintenance (compaction) pass. Surfaced via
 * `/api/status` so the admin UI can show a banner — compaction is CPU- and
 * IO-heavy, and an operator watching `top` should be able to tell it's loctx.
 */
export interface MaintenanceStatus {
  readonly running: boolean;
  /** ISO timestamp the current pass started; null when idle. */
  readonly startedAt: string | null;
  /** ISO timestamp the last pass finished; null until one completes. */
  readonly lastRunAt: string | null;
  /** Bytes reclaimed by the last completed pass; null until one completes. */
  readonly lastFreedBytes: number | null;
}

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
   * Catch up analyzer enrichments for already-indexed files — used when a
   * feature is enabled after the index is built. For each target analyzer
   * (default: all enabled), enqueues tasks only for files missing an
   * up-to-date enrichment, reading file content from disk. Embeddings are
   * never recomputed. Returns how many tasks were enqueued.
   */
  readonly backfillAnalyzers: (targets?: ReadonlyArray<string>) => Promise<{ enqueued: number }>;
  /**
   * Compact the vector store — merge Lance fragments + prune old version
   * history that's never reclaimed otherwise (#index-size). Returns the
   * on-disk vector-dir size before/after so the caller can report what was
   * freed.
   */
  readonly compactVectors: () => Promise<{ beforeBytes: number; afterBytes: number }>;
  /** Snapshot of the background compaction pass — running flag + last result. */
  readonly maintenanceStatus: () => MaintenanceStatus;
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

interface AnalyzerEnqueueParams {
  readonly project: Project;
  readonly fileId: FileId;
  readonly absPath: string;
  readonly contentSha: string;
}

/**
 * Enqueue the enabled analyzers for one indexed file, honoring tool
 * availability + rule-dir presence. Returns the number of tasks enqueued.
 * Shared by the indexer's `afterFileIndexed` hook (all enabled analyzers)
 * and the backfill (`only` scopes it to a single analyzer per file).
 */
function enqueueFileAnalyzers(
  config: Config,
  enrichments: EnrichmentQueue,
  params: AnalyzerEnqueueParams,
  only?: ReadonlySet<string>,
): number {
  if (!config.analyzers.backgroundEnabled) return 0;
  const { project, fileId, absPath, contentSha } = params;
  const want = (name: string): boolean => only === undefined || only.has(name);
  let enqueued = 0;

  if (
    want("lizard") &&
    config.analyzers.lizard.enabled &&
    toolReady("lizard", config.analyzers.lizard.command)
  ) {
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
    enqueued++;
  }
  if (want("duplicates") && config.analyzers.duplicates.enabled) {
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
        // CPU-only pass over the file body; the queue caps concurrency.
        run: async () => computeDuplicateWindows(readFileSync(absPath, "utf-8"), dupOpts),
      }),
    );
    enqueued++;
  }
  if (
    want("semgrep") &&
    config.analyzers.semgrep.enabled &&
    (config.analyzers.semgrep.ruleDirs.length > 0 ||
      config.analyzers.semgrep.registryConfig !== "") &&
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
              registryConfig: sg.registryConfig,
              maxFindingsPerFile: sg.maxFindingsPerFile,
            },
            signal,
          ),
      }),
    );
    enqueued++;
  }
  if (
    want("ast-grep") &&
    config.analyzers.astGrep.enabled &&
    (config.analyzers.astGrep.ruleDirs.length > 0 || config.analyzers.astGrep.bundledRules) &&
    toolReady("ast-grep", config.analyzers.astGrep.command)
  ) {
    const ag = config.analyzers.astGrep;
    // User rule dirs win; otherwise fall back to loctx's bundled starter set.
    const ruleDirs =
      ag.ruleDirs.length > 0 ? ag.ruleDirs : ag.bundledRules ? [bundledAstGrepRulesDir()] : [];
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
              ruleDirs,
              maxFindingsPerFile: ag.maxFindingsPerFile,
            },
            signal,
          ),
      }),
    );
    enqueued++;
  }
  if (want("definitions") && config.analyzers.definitions.enabled) {
    const def = config.analyzers.definitions;
    const rel = relative(project.root, absPath);
    if (matchesDefinitionGlobs(rel, def.globs)) {
      const schemas = resolveDefinitionSchemas(def.okfDefault, def.schemas);
      if (schemas.length > 0) {
        enrichments.enqueue(
          analyzerTaskMeta({
            fileId,
            project,
            analyzer: "definitions",
            analyzerVersion: DEFINITIONS_VERSION,
            contentSha,
            run: () =>
              runDefinitions(absPath, {
                schemas,
                maxFindingsPerFile: def.maxFindingsPerFile,
                requireFrontmatter: def.requireFrontmatter,
                checkLinks: def.checkLinks,
              }),
          }),
        );
        enqueued++;
      }
    }
  }
  return enqueued;
}

/** Analyzer name → its version + the config predicate gating a backfill. */
interface BackfillSpec {
  readonly name: string;
  readonly version: number;
  readonly active: boolean;
  readonly command: string | undefined;
  readonly external: boolean;
}

function backfillSpecs(config: Config): ReadonlyArray<BackfillSpec> {
  const a = config.analyzers;
  return [
    {
      name: "lizard",
      version: LIZARD_VERSION,
      active: a.lizard.enabled,
      command: a.lizard.command,
      external: true,
    },
    {
      name: "duplicates",
      version: DUPLICATES_VERSION,
      active: a.duplicates.enabled,
      command: undefined,
      external: false,
    },
    {
      name: "semgrep",
      version: SEMGREP_VERSION,
      active: a.semgrep.enabled && a.semgrep.ruleDirs.length > 0,
      command: a.semgrep.command,
      external: true,
    },
    {
      name: "ast-grep",
      version: AST_GREP_VERSION,
      active: a.astGrep.enabled && (a.astGrep.ruleDirs.length > 0 || a.astGrep.bundledRules),
      command: a.astGrep.command,
      external: true,
    },
    {
      name: "definitions",
      version: DEFINITIONS_VERSION,
      // Active when on with at least one schema source (OKF default or custom).
      active:
        a.definitions.enabled && (a.definitions.okfDefault || a.definitions.schemas.length > 0),
      command: undefined,
      external: false,
    },
  ];
}

/** Discovery wiring shared by {@link buildRuntime} and {@link buildStateRuntime}. */
function buildDiscovery(config: Config): WorkspaceDiscovery {
  const extraMarkers: MarkerSpec[] = config.discovery.extraMarkers.map((name) => ({
    name,
    kind: "file" as const,
    group: "build" as const,
  }));
  return new WorkspaceDiscovery(config.workspaceRoots, {
    maxDepth: config.discovery.maxDepth,
    markers:
      extraMarkers.length === 0
        ? DEFAULT_PROJECT_MARKERS
        : [...DEFAULT_PROJECT_MARKERS, ...extraMarkers],
  });
}

/**
 * The slice of {@link Runtime} that needs no embedding model: SQLite
 * state plus workspace discovery. For CLI commands that only read or
 * delete index rows (`find-usages`, `purge` no-daemon fallbacks),
 * {@link buildRuntime} was overkill — its unconditional
 * `embeddings.ensureReady()` loads the ~90MB ONNX model and costs
 * seconds of latency for work that never embeds anything (#448).
 */
export interface StateRuntime {
  readonly config: Config;
  readonly state: StateStore;
  readonly discovery: WorkspaceDiscovery;
  close(): void;
}

/**
 * Build a state-only runtime: no embedding warmup, no vector-store
 * construction, no analyzer probes. Synchronous — there is nothing to
 * await. See {@link StateRuntime} for when to prefer this over
 * {@link buildRuntime}.
 */
export function buildStateRuntime(config: Config): StateRuntime {
  const state = new StateStore(config.paths.stateDb);
  const discovery = buildDiscovery(config);
  return Object.freeze({
    config,
    state,
    discovery,
    close: () => state.close(),
  });
}

export async function buildRuntime(config: Config): Promise<Runtime> {
  // Apply proxy / CA / TLS settings before anything makes an outbound
  // request (the embedding-model download). No-op when network config is
  // default. See #385.
  applyNetworkSettings(config.network);
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
  const discovery = buildDiscovery(config);

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
    afterFileIndexed: (p) => {
      enqueueFileAnalyzers(config, enrichments, p);
    },
  });
  const reconciler = new Reconciler(state, indexer);
  const searcher = new WorkspaceSearcher(vectors, embeddings, discovery, state, config.retrieval);

  // Live compaction state — mutated by compactVectors() so /api/status can
  // show a "compacting" banner regardless of whether the pass was triggered
  // manually (admin button) or by the daemon's auto-compaction timer.
  const maintenance = {
    running: false,
    startedAt: null as string | null,
    lastRunAt: null as string | null,
    lastFreedBytes: null as number | null,
  };

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
    backfillAnalyzers: async (targets?: ReadonlyArray<string>) => {
      if (!config.analyzers.backgroundEnabled) return { enqueued: 0 };
      const wanted = backfillSpecs(config).filter(
        (s) => s.active && (targets === undefined || targets.includes(s.name)),
      );
      // Probe external tools up front so toolReady is decided before we
      // query/enqueue (the boot-time eager probe may not have covered an
      // analyzer enabled later via hot-reload).
      await Promise.all(
        wanted
          .filter((s) => s.external && s.command !== undefined)
          .map((s) => probeTool(s.name, s.command as string)),
      );
      let enqueued = 0;
      for (const proj of state.listProjects()) {
        const project: Project = { id: proj.id, name: proj.name, root: proj.root };
        for (const s of wanted) {
          if (s.external && (s.command === undefined || !toolReady(s.name, s.command))) continue;
          for (const f of state.listFilesMissingEnrichment(proj.id, s.name, s.version)) {
            enqueued += enqueueFileAnalyzers(
              config,
              enrichments,
              {
                project,
                fileId: f.fileId,
                absPath: join(project.root, f.relPath),
                contentSha: f.contentSha,
              },
              new Set([s.name]),
            );
          }
        }
      }
      if (enqueued > 0) {
        console.error(
          `[loctx analyzers] backfill enqueued ${enqueued} task(s) for already-indexed files: ${wanted
            .map((s) => s.name)
            .join(", ")}`,
        );
      }
      return { enqueued };
    },
    compactVectors: async () => {
      maintenance.running = true;
      maintenance.startedAt = new Date().toISOString();
      try {
        const beforeBytes = dirSizeBytes(config.paths.vectorDir);
        await vectors.compact();
        const afterBytes = dirSizeBytes(config.paths.vectorDir);
        maintenance.lastRunAt = new Date().toISOString();
        maintenance.lastFreedBytes = Math.max(0, beforeBytes - afterBytes);
        return { beforeBytes, afterBytes };
      } finally {
        maintenance.running = false;
      }
    },
    maintenanceStatus: () => ({ ...maintenance }),
    close: async () => {
      await embeddings.dispose?.();
      state.close();
    },
  });
}

/** Recursive on-disk size of a directory in bytes (best-effort). */
function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) total += dirSizeBytes(p);
      else
        try {
          total += statSync(p).size;
        } catch {
          // unreadable file — skip
        }
    }
  } catch {
    // missing dir — 0
  }
  return total;
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
