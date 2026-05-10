/**
 * Filesystem watcher: keeps the local index in sync with on-disk changes.
 *
 * Uses chokidar to watch a project's root, debounces per-file events, and
 * dispatches add/change/unlink to the ProjectIndexer. The watcher is the
 * non-CLI half of "fs monitor + indexer" — it shares the same indexer
 * instance the CLI uses, so writes go through the same code path.
 *
 * Concurrency: chokidar fires events in order; we debounce per absolute path
 * so rapid editor saves coalesce. The indexer is async, so we serialize
 * dispatches behind a per-path queue to avoid two concurrent indexFile calls
 * for the same file.
 */

import { join, resolve } from "node:path";
import type { ProjectIndexer } from "../indexing/index.js";
import type { Project } from "../models.js";
import { watcherBus } from "./bus.js";

/**
 * Per-project ignore-rule files (#89). Watched in a side channel so a
 * change triggers a filter re-evaluation rather than treating the file
 * itself as content. `.git/info/exclude` lives inside `.git`, which is
 * excluded from the main watcher's chokidar config — it gets a
 * dedicated narrow watcher.
 */
const RULE_FILES = [".loctxignore", ".gitignore", ".git/info/exclude"] as const;

type WatchEvent = "add" | "change" | "unlink";

type ChokidarEvent =
  | "add"
  | "addDir"
  | "change"
  | "unlink"
  | "unlinkDir"
  | "ready"
  | "raw"
  | "error"
  | "all";

interface ChokidarWatcher {
  on(event: "add" | "change" | "unlink", handler: (path: string) => void): this;
  on(event: "error", handler: (err: unknown) => void): this;
  on(event: "ready", handler: () => void): this;
  on(event: ChokidarEvent, handler: (...args: unknown[]) => void): this;
  close(): Promise<void>;
}

interface ChokidarModule {
  watch(paths: string | readonly string[], options: Record<string, unknown>): ChokidarWatcher;
}

export interface WatcherServiceOptions {
  /** Per-path event debounce window in milliseconds. */
  readonly debounceMs?: number;
  /** Glob patterns that should be excluded from watching. */
  readonly ignored?: ReadonlyArray<string>;
  /** Called with each (event, relPath) — useful for logging in tests / CLI. */
  readonly onEvent?: (event: WatchEvent, relPath: string) => void;
  /** Called when an indexer call throws — defaults to console.error. */
  readonly onError?: (event: WatchEvent, relPath: string, error: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 300;

const DEFAULT_IGNORED = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
];

/**
 * Watch a single project. Each `WatcherService` instance owns one chokidar
 * watcher and forwards filtered events to the supplied indexer.
 */
export class WatcherService {
  private watcher: ChokidarWatcher | null = null;
  private rulesWatcher: ChokidarWatcher | null = null;
  private rulesPending: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly ignored: ReadonlyArray<string>;
  private readonly onEvent: (event: WatchEvent, relPath: string) => void;
  private readonly onError: (event: WatchEvent, relPath: string, error: Error) => void;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Set<string>();

  constructor(
    public readonly project: Project,
    public readonly indexer: ProjectIndexer,
    options: WatcherServiceOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.ignored = options.ignored ?? DEFAULT_IGNORED;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onError =
      options.onError ??
      ((event, path, err) => {
        console.error(`[watcher] ${event} ${path}: ${err.message}`);
      });
  }

  async start(): Promise<void> {
    if (this.watcher !== null) return;
    // Lazy import: chokidar pulls in fsevents on macOS; keep core import light.
    const moduleName = "chokidar";
    const mod = (await import(moduleName)) as unknown as ChokidarModule;
    const watcher = mod.watch(this.project.root, {
      ignored: [...this.ignored],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    watcher.on("add", (path) => this.schedule("add", path));
    watcher.on("change", (path) => this.schedule("change", path));
    watcher.on("unlink", (path) => this.schedule("unlink", path));
    watcher.on("error", (err) => {
      console.error(`[watcher] error: ${(err as Error)?.message ?? err}`);
    });
    this.watcher = watcher;

    // Side channel for ignore-rule files (#89). chokidar accepts a list
    // of explicit paths; missing files are tolerated and add events fire
    // when they're created later. Same debounce window as content events.
    const rulePaths = RULE_FILES.map((p) => join(this.project.root, p));
    const rulesWatcher = mod.watch(rulePaths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    rulesWatcher.on("add", () => this.scheduleRulesReeval());
    rulesWatcher.on("change", () => this.scheduleRulesReeval());
    rulesWatcher.on("unlink", () => this.scheduleRulesReeval());
    rulesWatcher.on("error", (err) => {
      console.error(`[watcher rules] error: ${(err as Error)?.message ?? err}`);
    });
    this.rulesWatcher = rulesWatcher;
  }

  async stop(): Promise<void> {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    if (this.rulesPending !== null) {
      clearTimeout(this.rulesPending);
      this.rulesPending = null;
    }
    if (this.watcher !== null) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.rulesWatcher !== null) {
      await this.rulesWatcher.close();
      this.rulesWatcher = null;
    }
  }

  private scheduleRulesReeval(): void {
    if (this.rulesPending !== null) clearTimeout(this.rulesPending);
    this.rulesPending = setTimeout(() => {
      this.rulesPending = null;
      void this.dispatchRulesReeval();
    }, this.debounceMs);
  }

  private async dispatchRulesReeval(): Promise<void> {
    try {
      const summary = await this.indexer.reevaluateFilter(this.project);
      if (summary.pruned > 0) {
        console.error(
          `[watcher] ignore rules changed for ${this.project.name}; pruned ${summary.pruned} file(s) from the index`,
        );
        for (const relPath of summary.prunedRelPaths) {
          watcherBus.publish({
            projectId: this.project.id,
            projectName: this.project.name,
            relPath,
            kind: "unlink",
            at: Date.now(),
          });
        }
      }
    } catch (err) {
      this.onError("change", ".loctxignore", err as Error);
    }
  }

  private schedule(event: WatchEvent, absPath: string): void {
    const key = resolve(absPath);
    const existing = this.pending.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this.pending.delete(key);
      void this.dispatch(event, key);
    }, this.debounceMs);
    this.pending.set(key, timeout);
  }

  private async dispatch(event: WatchEvent, absPath: string): Promise<void> {
    if (this.inflight.has(absPath)) {
      // Reschedule once the in-flight call clears.
      this.schedule(event, absPath);
      return;
    }
    this.inflight.add(absPath);
    const relPath = absPath.startsWith(this.project.root)
      ? absPath.slice(this.project.root.length + 1)
      : absPath;
    this.onEvent(event, relPath);
    try {
      if (event === "unlink") {
        await this.indexer.deleteFile(this.project, relPath);
      } else {
        await this.indexer.indexFile(this.project, absPath);
      }
      watcherBus.publish({
        projectId: this.project.id,
        projectName: this.project.name,
        relPath,
        kind: event,
        at: Date.now(),
      });
    } catch (err) {
      this.onError(event, relPath, err as Error);
    } finally {
      this.inflight.delete(absPath);
    }
  }
}
