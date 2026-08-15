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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  QUALITY_VERSION,
  type QualityIndexReader,
  resolveDefinitionSchemas,
  runAstGrep,
  runDefinitions,
  runLizard,
  runQuality,
  runSemgrep,
  SEMGREP_VERSION,
  toUnit,
} from "./analyzers/index.js";
import type { LizardFileResult } from "./analyzers/lizard.js";
import {
  buildQualityReport,
  type QualityReport,
  type QualityReportPorts,
} from "./analyzers/quality-report.js";
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
import { AnalyzerEventCoalescer, watcherBus } from "./watcher/index.js";

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
   * Per-runtime probe cache for external analyzer binaries (CORE-11).
   * Owned by the runtime so tests can construct isolated runtimes (and
   * seed availability) without sharing process-global probe state.
   */
  readonly tools: ToolProbeCache;
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

const TOOL_DETECTORS: Record<string, (command: string) => Promise<string | null>> = {
  lizard: detectLizard,
  semgrep: detectSemgrep,
  "ast-grep": detectAstGrep,
};

/**
 * Memoized availability of external analyzer binaries (lizard, semgrep,
 * ast-grep), keyed by command. External analyzers ship enabled by default
 * (#defaults), so without this an absent binary would enqueue a failing
 * task for every indexed file. Each command is probed once:
 *   - eagerly in {@link buildRuntime} for the analyzers active at boot,
 *     so the first indexed file already knows the answer; and
 *   - lazily from the index hook when an analyzer is enabled later via
 *     hot-reloaded config (applies to files indexed after that point;
 *     rebuild to backfill already-indexed files).
 * Unknown (probe in flight) returns false so we skip rather than fail.
 *
 * One instance per runtime (CORE-11) — this used to be module-global
 * mutable state shared across every runtime in the process, which made
 * isolated tests impossible and leaked probe results between runtimes
 * with different configs.
 */
export class ToolProbeCache {
  private readonly availability = new Map<string, boolean>();
  private readonly probing = new Set<string>();
  private readonly pinned = new Set<string>();

  async probe(kind: string, command: string): Promise<boolean> {
    // Seeded decisions win: a pinned command never shells out (see seed()).
    if (this.pinned.has(command)) return this.availability.get(command) === true;
    const found = (await TOOL_DETECTORS[kind]?.(command)) ?? null;
    this.availability.set(command, found !== null);
    if (found === null) {
      console.error(
        `[loctx analyzers] '${command}' (${kind}) not found on PATH; skipping until installed.`,
      );
    }
    return found !== null;
  }

  ready(kind: string, command: string): boolean {
    const cached = this.availability.get(command);
    if (cached !== undefined) return cached;
    if (!this.probing.has(command)) {
      this.probing.add(command);
      void this.probe(kind, command).finally(() => this.probing.delete(command));
    }
    return false; // probe in flight — skip this round
  }

  /**
   * Pin a command's availability without shelling out; later probe()
   * calls return the pinned value instead of re-detecting. Test seam:
   * lets container tests exercise the enqueue/backfill policy for
   * external analyzers on machines without the binaries installed.
   */
  seed(command: string, available: boolean): void {
    this.availability.set(command, available);
    this.pinned.add(command);
  }
}

interface AnalyzerEnqueueParams {
  readonly project: Project;
  readonly fileId: FileId;
  readonly absPath: string;
  readonly contentSha: string;
  /**
   * Read-only index access for analyzers that consume already-indexed
   * signals (the quality analyzer's port, #522). Supplied by the
   * runtime's StateStore adapter; consulted at task run time.
   */
  readonly index: QualityIndexReader;
}

type AnalyzerTask = ReturnType<typeof analyzerTaskMeta>;

/**
 * Everything the runtime needs to know about one analyzer, in one row.
 */
export interface AnalyzerDescriptor {
  readonly name: string;
  /** Version stamped on enrichments; bumping re-enqueues on backfill. */
  readonly version: number;
  /**
   * The single activation policy, consumed by BOTH the indexing enqueue
   * path and the backfill (CORE-1). These used to be two hand-written
   * lists that drifted: the shipped default (`semgrep.ruleDirs: []`,
   * `registryConfig: "p/default"`) ran semgrep during indexing while
   * backfill required non-empty ruleDirs and silently never touched
   * already-indexed files.
   */
  readonly isActive: (config: Config) => boolean;
  /** External binary to probe before enqueuing, or null for pure-JS analyzers. */
  readonly command: (config: Config) => string | null;
  /**
   * Build the enrichment task for one file. Null when this particular
   * file is out of scope (e.g. definitions' glob/schema filter).
   */
  readonly buildTask: (config: Config, params: AnalyzerEnqueueParams) => AnalyzerTask | null;
}

export const ANALYZERS: ReadonlyArray<AnalyzerDescriptor> = [
  {
    name: "lizard",
    version: LIZARD_VERSION,
    isActive: (c) => c.analyzers.lizard.enabled,
    command: (c) => c.analyzers.lizard.command,
    buildTask: (config, { project, fileId, absPath, contentSha }) => {
      const command = config.analyzers.lizard.command;
      return analyzerTaskMeta({
        fileId,
        project,
        analyzer: "lizard",
        analyzerVersion: LIZARD_VERSION,
        contentSha,
        absPath,
        run: (signal) => runLizard(command, absPath, signal),
      });
    },
  },
  {
    name: "duplicates",
    version: DUPLICATES_VERSION,
    isActive: (c) => c.analyzers.duplicates.enabled,
    command: () => null,
    buildTask: (config, { project, fileId, absPath, contentSha }) => {
      const dupOpts = {
        windowSize: config.analyzers.duplicates.windowSize,
        minUniqueTokens: config.analyzers.duplicates.minUniqueTokens,
      };
      return analyzerTaskMeta({
        fileId,
        project,
        analyzer: "duplicates",
        analyzerVersion: DUPLICATES_VERSION,
        contentSha,
        absPath,
        // CPU-only pass over the file body; the queue caps concurrency.
        run: async () => computeDuplicateWindows(readFileSync(absPath, "utf-8"), dupOpts),
      });
    },
  },
  {
    name: "semgrep",
    version: SEMGREP_VERSION,
    // Active with local rule dirs OR a registry fallback ruleset — the
    // shipped default is registry-only, so `registryConfig !== ""` must
    // count (the CORE-1 backfill bug was exactly this clause missing).
    isActive: (c) =>
      c.analyzers.semgrep.enabled &&
      (c.analyzers.semgrep.ruleDirs.length > 0 || c.analyzers.semgrep.registryConfig !== ""),
    command: (c) => c.analyzers.semgrep.command,
    buildTask: (config, { project, fileId, absPath, contentSha }) => {
      const sg = config.analyzers.semgrep;
      return analyzerTaskMeta({
        fileId,
        project,
        analyzer: "semgrep",
        analyzerVersion: SEMGREP_VERSION,
        contentSha,
        absPath,
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
      });
    },
  },
  {
    name: "ast-grep",
    version: AST_GREP_VERSION,
    isActive: (c) =>
      c.analyzers.astGrep.enabled &&
      (c.analyzers.astGrep.ruleDirs.length > 0 || c.analyzers.astGrep.bundledRules),
    command: (c) => c.analyzers.astGrep.command,
    buildTask: (config, { project, fileId, absPath, contentSha }) => {
      const ag = config.analyzers.astGrep;
      // User rule dirs win; otherwise fall back to loctx's bundled starter set.
      const ruleDirs =
        ag.ruleDirs.length > 0 ? ag.ruleDirs : ag.bundledRules ? [bundledAstGrepRulesDir()] : [];
      return analyzerTaskMeta({
        fileId,
        project,
        analyzer: "ast-grep",
        analyzerVersion: AST_GREP_VERSION,
        contentSha,
        absPath,
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
      });
    },
  },
  {
    name: "definitions",
    version: DEFINITIONS_VERSION,
    // Active when on with at least one schema source (OKF default or
    // custom). buildTask narrows further per file via the glob filter.
    isActive: (c) =>
      c.analyzers.definitions.enabled &&
      (c.analyzers.definitions.okfDefault || c.analyzers.definitions.schemas.length > 0),
    command: () => null,
    buildTask: (config, { project, fileId, absPath, contentSha }) => {
      const def = config.analyzers.definitions;
      const rel = relative(project.root, absPath);
      if (!matchesDefinitionGlobs(rel, def.globs)) return null;
      const schemas = resolveDefinitionSchemas(def.okfDefault, def.schemas);
      if (schemas.length === 0) return null;
      return analyzerTaskMeta({
        fileId,
        project,
        analyzer: "definitions",
        analyzerVersion: DEFINITIONS_VERSION,
        contentSha,
        absPath,
        run: () =>
          runDefinitions(absPath, {
            schemas,
            maxFindingsPerFile: def.maxFindingsPerFile,
            requireFrontmatter: def.requireFrontmatter,
            checkLinks: def.checkLinks,
          }),
      });
    },
  },
  {
    // Enqueue order puts quality last, but with concurrency > 1 the
    // pure-JS rules can still finish before the lizard subprocess. The
    // result-sink re-enqueues quality when lizard's result lands (see
    // buildRuntime's onResult), so the degraded pass upgrades instead
    // of being cached until the next edit.
    name: "quality",
    version: QUALITY_VERSION,
    isActive: (c) => c.analyzers.quality.enabled,
    command: () => null,
    buildTask: (config, { project, fileId, absPath, contentSha, index }) => {
      const q = config.analyzers.quality;
      return analyzerTaskMeta({
        fileId,
        project,
        analyzer: "quality",
        analyzerVersion: QUALITY_VERSION,
        contentSha,
        absPath,
        // Index reads (chunk metadata, lizard) happen at run time,
        // after the indexer's write for this file committed.
        run: () =>
          runQuality(absPath, fileId, contentSha, index, {
            thresholds: q,
            maxFindingsPerFile: q.maxFindingsPerFile,
            ...(q.markdownRules ? { markdown: { projectRoot: project.root } } : {}),
          }),
      });
    },
  },
];

/** `only` filter for the lizard→quality catch-up re-enqueue. */
const QUALITY_ONLY: ReadonlySet<string> = new Set(["quality"]);

/**
 * Enqueue the active analyzers for one indexed file, honoring tool
 * availability. Returns the number of tasks enqueued. Shared by the
 * indexer's `afterFileIndexed` hook (all active analyzers) and the
 * backfill (`only` scopes it to a single analyzer per file). Activation
 * comes from each {@link ANALYZERS} row's `isActive`, so this path and
 * the backfill can no longer disagree (CORE-1).
 */
function enqueueFileAnalyzers(
  config: Config,
  enrichments: EnrichmentQueue,
  tools: ToolProbeCache,
  params: AnalyzerEnqueueParams,
  only?: ReadonlySet<string>,
): number {
  if (!config.analyzers.backgroundEnabled) return 0;
  let enqueued = 0;
  for (const analyzer of ANALYZERS) {
    if (only !== undefined && !only.has(analyzer.name)) continue;
    if (!analyzer.isActive(config)) continue;
    const command = analyzer.command(config);
    if (command !== null && !tools.ready(analyzer.name, command)) continue;
    const task = analyzer.buildTask(config, params);
    if (task === null) continue;
    enrichments.enqueue(task);
    enqueued++;
  }
  return enqueued;
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
  const tools = new ToolProbeCache();

  // Probe the external analyzers active at boot so the first indexed file
  // already knows whether to enqueue (avoids the initial-index race where
  // many files would skip before a lazy probe resolves).
  if (config.analyzers.backgroundEnabled) {
    await Promise.all(
      ANALYZERS.filter((a) => a.isActive(config)).map((a) => {
        const command = a.command(config);
        return command !== null ? tools.probe(a.name, command) : null;
      }),
    );
  }
  // Lazy providers (Local) need a warmup; in-process providers (Fake) skip it.
  await embeddings.ensureReady?.();
  const vectors = createVectorStore(config.paths.vectorDir, embeddings.identity, state);
  const discovery = buildDiscovery(config);

  const filterFor = (project: Project): ProjectFilter =>
    new ProjectFilter(project, rules, combinedGitignore(project.root));

  // StateStore adapted onto the quality analyzer's reader port (#522).
  // Defined once per runtime; handed to every enqueue site via
  // AnalyzerEnqueueParams so the descriptor table stays state-free.
  const qualityIndex: QualityIndexReader = {
    chunksForFile: (fileId) => state.listChunksWithMetadata(fileId),
    lizardForFile: (fileId, contentSha) => {
      const row = state.getFileEnrichment(fileId, "lizard");
      // A lizard row computed from different content (the file's previous
      // version) must read as "not run" — stale line ranges and CCNs
      // would otherwise shape findings cached under the NEW sha.
      if (row === null || row.contentSha !== contentSha) return null;
      return parseLizardPayload(row);
    },
  };

  // Coalesced analyzer completion events (#526): the admin UI's SSE
  // stream gets one event per (analyzer, project) batch instead of one
  // per file, so backfills don't flood it.
  const analyzerEvents = new AnalyzerEventCoalescer(watcherBus.publish);

  // Background analyzer queue + persistence sink. Each completion writes
  // to file_enrichments so reconciliation / status / search can read it.
  const enrichments = new EnrichmentQueue({
    concurrency: config.analyzers.concurrency,
    perTaskTimeoutMs: config.analyzers.perTaskTimeoutMs,
    onResult: (r) => {
      const meta = r.task as ReturnType<typeof analyzerTaskMeta>;
      // Record the bus event FIRST: a throwing upsert (disk full,
      // locked DB — the case the queue's sink catch exists for) must
      // not also silence the admin UI's only progress signal. Only
      // terminal statuses count; a future "skipped" is neither a
      // completion nor a failure.
      if (r.status === "complete" || r.status === "failed") {
        analyzerEvents.record(meta.analyzer, meta.project.id, r.status);
      }
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
      // Precision catch-up (#522): quality's pure-JS pass usually beats
      // the lizard subprocess, runs degraded (no CCN escalation, coarse
      // param counts), and would stay cached under this contentSha. When
      // lizard's result lands, invalidate + re-run quality once so the
      // findings upgrade. No loop risk: quality completions trigger
      // nothing, and lizard itself dedupes per (sha, version). Known
      // narrow race: if quality is mid-flight at this instant the
      // enqueue is a no-op (inflight dedupe) and that pass stays
      // degraded until the file next changes — accepted; the window is
      // milliseconds against lizard's seconds.
      if (meta.analyzer === "lizard" && r.status === "complete") {
        enrichments.invalidate(`quality:${meta.fileId}`);
        enqueueFileAnalyzers(
          config,
          enrichments,
          tools,
          {
            project: meta.project,
            fileId: meta.fileId,
            absPath: meta.absPath,
            contentSha: meta.contentSha,
            index: qualityIndex,
          },
          QUALITY_ONLY,
        );
      }
    },
  });

  const indexer = new ProjectIndexer(state, vectors, embeddings, filterFor, {
    afterFileIndexed: (p) => {
      enqueueFileAnalyzers(config, enrichments, tools, { ...p, index: qualityIndex });
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
    tools,
    backfillAnalyzers: async (targets?: ReadonlyArray<string>) => {
      if (!config.analyzers.backgroundEnabled) return { enqueued: 0 };
      // Same ANALYZERS rows (and the same isActive policy) the indexing
      // path reads — the two paths can no longer drift (CORE-1).
      const wanted = ANALYZERS.filter(
        (a) => a.isActive(config) && (targets === undefined || targets.includes(a.name)),
      );
      // Probe external tools up front so tools.ready is decided before we
      // query/enqueue (the boot-time eager probe may not have covered an
      // analyzer enabled later via hot-reload).
      await Promise.all(
        wanted.map((a) => {
          const command = a.command(config);
          return command !== null ? tools.probe(a.name, command) : null;
        }),
      );
      let enqueued = 0;
      for (const proj of state.listProjects()) {
        const project: Project = { id: proj.id, name: proj.name, root: proj.root };
        for (const a of wanted) {
          const command = a.command(config);
          if (command !== null && !tools.ready(a.name, command)) continue;
          for (const f of state.listFilesMissingEnrichment(proj.id, a.name, a.version)) {
            enqueued += enqueueFileAnalyzers(
              config,
              enrichments,
              tools,
              {
                project,
                fileId: f.fileId,
                absPath: join(project.root, f.relPath),
                contentSha: f.contentSha,
                index: qualityIndex,
              },
              new Set([a.name]),
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
      // Best-effort: publishes any pending batch to still-attached
      // listeners. The long-lived daemon tears down harder than this
      // (its shutdown SIGKILLs without runtime.close()) — losing the
      // final window there is fine; its SSE clients are gone too.
      analyzerEvents.flush();
      await embeddings.dispose?.();
      state.close();
    },
  });
}

/**
 * Project quality report (#525): adapt the runtime onto the report's
 * ports and run it. Shared by the MCP `quality_report` tool and the web
 * `/api/projects/:id/quality` route so the two surfaces cannot drift.
 */
export async function runQualityReport(
  runtime: Pick<Runtime, "config" | "state" | "vectors">,
  project: Project,
  opts: { readonly limit: number; readonly rule?: string },
): Promise<QualityReport> {
  const { state, vectors } = runtime;
  const ports: QualityReportPorts = {
    qualityEnrichments: (pid) => state.listQualityEnrichments(pid),
    duplicateGroups: (min, pid) => state.findDuplicateGroups(min, pid),
    fanInCounts: (pid) => state.fanInCounts(pid),
    scanChunks: (pid, limit) => vectors.scanChunks({ projectId: pid, limit }),
    listFiles: (pid) => state.listFiles(pid).map((f) => ({ fileId: f.fileId, relPath: f.relPath })),
    readFileContent: async (absPath) => {
      try {
        return await readFile(absPath, "utf-8");
      } catch {
        return null;
      }
    },
    exists: existsSync,
    vectors: {
      chunkVectorsForPath: async (pid, relPath) => {
        const file = state.getFile(pid, relPath);
        if (file === null) return [];
        const rows = await vectors.scanChunks({ projectId: pid, fileId: file.fileId, limit: 128 });
        return rows.map((r) => toUnit(r.vector)).filter((v): v is Float32Array => v !== null);
      },
    },
  };
  const q = runtime.config.analyzers.quality;
  return buildQualityReport(ports, {
    projectId: project.id,
    projectRoot: project.root,
    thresholds: q,
    markdownRules: q.markdownRules,
    driftFloor: q.docDriftFloor / 100,
    limit: opts.limit,
    ...(opts.rule !== undefined ? { ruleFilter: opts.rule } : {}),
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
  absPath: string;
  run: (signal?: AbortSignal) => Promise<unknown>;
}) {
  return {
    id: `${input.analyzer}:${input.fileId}`,
    analyzer: input.analyzer,
    analyzerVersion: input.analyzerVersion,
    contentSha: input.contentSha,
    fileId: input.fileId,
    project: input.project,
    absPath: input.absPath,
    run: input.run,
  };
}

/**
 * Parse a lizard enrichment row into its payload. Null on any miss
 * (never ran, failed, unparseable) — the quality rules treat that as
 * "lizard unavailable" and degrade.
 */
function parseLizardPayload(
  row: { readonly status: string; readonly payloadJson?: string } | null,
): LizardFileResult | null {
  if (row === null || row.status !== "complete" || row.payloadJson === undefined) return null;
  try {
    return JSON.parse(row.payloadJson) as LizardFileResult;
  } catch {
    return null;
  }
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
