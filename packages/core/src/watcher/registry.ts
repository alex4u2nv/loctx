/**
 * Per-project watcher registry.
 *
 * The integrated daemon runs one WatcherService per project. The web
 * server needs both observability (which projects are being watched and
 * what state they're in) and control (pause/resume one). This registry
 * is the seam.
 */

import type { ProjectId } from "../models.js";
import type { WatcherService } from "./service.js";

export type WatcherState = "active" | "paused" | "failed";

export interface WatcherEntry {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly watcher: WatcherService;
  readonly startedAt: string;
  state: WatcherState;
  failureReason: string | null;
}

export interface WatcherSnapshot {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly state: WatcherState;
  readonly startedAt: string;
  readonly failureReason: string | null;
}

export class WatcherRegistry {
  private readonly entries = new Map<string, WatcherEntry>();

  register(
    entry: Omit<WatcherEntry, "state" | "failureReason"> & {
      state?: WatcherState;
      failureReason?: string | null;
    },
  ): void {
    const full: WatcherEntry = {
      ...entry,
      state: entry.state ?? "active",
      failureReason: entry.failureReason ?? null,
    };
    this.entries.set(entry.projectId, full);
  }

  unregister(projectId: ProjectId): void {
    this.entries.delete(projectId);
  }

  get(projectId: ProjectId): WatcherEntry | null {
    return this.entries.get(projectId) ?? null;
  }

  list(): ReadonlyArray<WatcherSnapshot> {
    return [...this.entries.values()].map((e) => ({
      projectId: e.projectId,
      projectName: e.projectName,
      projectRoot: e.projectRoot,
      state: e.state,
      startedAt: e.startedAt,
      failureReason: e.failureReason,
    }));
  }

  pause(projectId: ProjectId): WatcherEntry | null {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return null;
    entry.watcher.pause();
    entry.state = "paused";
    return entry;
  }

  resume(projectId: ProjectId): WatcherEntry | null {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return null;
    entry.watcher.resume();
    entry.state = "active";
    entry.failureReason = null;
    return entry;
  }

  markFailed(projectId: ProjectId, reason: string): void {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return;
    entry.state = "failed";
    entry.failureReason = reason;
  }
}
