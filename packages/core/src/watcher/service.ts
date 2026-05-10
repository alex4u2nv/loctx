/**
 * Filesystem watcher: keeps the local index in sync with on-disk changes.
 *
 * Uses @parcel/watcher (native FSEvents on macOS, inotify on Linux,
 * ReadDirectoryChangesW on Windows). One subscription per project root,
 * regardless of subdirectory count, so the watcher does not exhaust the
 * kernel's file-watch budget on multi-project workspaces.
 *
 * Concurrency: parcel emits events in batches; we debounce per absolute
 * path so rapid editor saves coalesce. The indexer is async, so we
 * serialize dispatches behind a per-path inflight set to avoid two
 * concurrent indexFile calls for the same file.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectIndexer } from "../indexing/index.js";
import type { Project } from "../models.js";
import { watcherBus } from "./bus.js";

/** Per-project ignore-rule files (#89). */
const RULE_FILES = [".loctxignore", ".gitignore"] as const;
/** Inside `.git/`; needs a separate narrow subscription because the
 * main subscription excludes `.git/` for noise reasons. */
const GIT_INFO_DIR = ".git/info";
const GIT_EXCLUDE_FILE = "exclude";

type WatchEvent = "add" | "change" | "unlink";

/** parcel/watcher event shape. */
type ParcelEventType = "create" | "update" | "delete";
interface ParcelEvent {
  readonly type: ParcelEventType;
  readonly path: string;
}

interface ParcelSubscription {
  unsubscribe(): Promise<void>;
}

interface ParcelModule {
  subscribe(
    dir: string,
    callback: (err: Error | null, events: ParcelEvent[]) => void,
    opts?: { ignore?: string[]; backend?: string },
  ): Promise<ParcelSubscription>;
}

/** Map parcel event types to our internal verbs. */
const EVENT_MAP: Record<ParcelEventType, WatchEvent> = {
  create: "add",
  update: "change",
  delete: "unlink",
};

export interface WatcherServiceOptions {
  readonly debounceMs?: number;
  /** Glob/path patterns excluded from watching. Passed to parcel's `ignore`. */
  readonly ignored?: ReadonlyArray<string>;
  readonly onEvent?: (event: WatchEvent, relPath: string) => void;
  readonly onError?: (event: WatchEvent, relPath: string, error: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * @parcel/watcher's `ignore` accepts glob patterns or absolute paths.
 * We feed it directory names; the matcher handles them as path components.
 */
const DEFAULT_IGNORED = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/target/**",
  "**/vendor/**",
];

export class WatcherService {
  private mainSub: ParcelSubscription | null = null;
  private gitInfoSub: ParcelSubscription | null = null;
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
    if (this.mainSub !== null) return;
    // Lazy import: keep core module load light.
    const moduleName = "@parcel/watcher";
    const mod = (await import(moduleName)) as unknown as ParcelModule;

    // Main subscription: project root, ignoring build/dep dirs and
    // `.git/`. Rule files at the root (.loctxignore, .gitignore) come
    // through here and are routed in the handler.
    this.mainSub = await mod.subscribe(
      this.project.root,
      (err, events) => {
        if (err !== null) {
          console.error(`[watcher] error: ${err.message}`);
          return;
        }
        for (const ev of events) this.routeEvent(ev);
      },
      { ignore: [...this.ignored] },
    );

    // Side channel for `.git/info/exclude` (#89). The main subscription
    // ignores `.git/`, so we attach a narrow subscription to `.git/info/`
    // and filter for the `exclude` filename. Skip silently when the
    // directory does not exist (project has no git, or git versions
    // without info/exclude).
    const gitInfoPath = join(this.project.root, GIT_INFO_DIR);
    if (existsSync(gitInfoPath)) {
      this.gitInfoSub = await mod.subscribe(gitInfoPath, (err, events) => {
        if (err !== null) {
          console.error(`[watcher rules] error: ${err.message}`);
          return;
        }
        for (const ev of events) {
          if (ev.path.endsWith(`/${GIT_EXCLUDE_FILE}`)) {
            this.scheduleRulesReeval();
          }
        }
      });
    }
  }

  async stop(): Promise<void> {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    if (this.rulesPending !== null) {
      clearTimeout(this.rulesPending);
      this.rulesPending = null;
    }
    if (this.mainSub !== null) {
      await this.mainSub.unsubscribe();
      this.mainSub = null;
    }
    if (this.gitInfoSub !== null) {
      await this.gitInfoSub.unsubscribe();
      this.gitInfoSub = null;
    }
  }

  /**
   * Direct events: rule files reload the filter; everything else
   * follows the normal index/delete path.
   */
  private routeEvent(ev: ParcelEvent): void {
    const rel = this.relPath(ev.path);
    if (RULE_FILES.includes(rel as (typeof RULE_FILES)[number])) {
      this.scheduleRulesReeval();
      return;
    }
    this.schedule(EVENT_MAP[ev.type], ev.path);
  }

  private relPath(absPath: string): string {
    if (absPath.startsWith(`${this.project.root}/`)) {
      return absPath.slice(this.project.root.length + 1);
    }
    return absPath;
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
      this.schedule(event, absPath);
      return;
    }
    this.inflight.add(absPath);
    const relPath = this.relPath(absPath);
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
