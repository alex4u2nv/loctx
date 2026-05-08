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

import { resolve } from "node:path";
import type { ProjectIndexer } from "../indexing/index.js";
import type { Project } from "../models.js";

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
  }

  async stop(): Promise<void> {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    if (this.watcher !== null) {
      await this.watcher.close();
      this.watcher = null;
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
    } catch (err) {
      this.onError(event, relPath, err as Error);
    } finally {
      this.inflight.delete(absPath);
    }
  }
}
