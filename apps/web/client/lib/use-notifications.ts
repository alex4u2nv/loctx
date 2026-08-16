/**
 * Derive a list of operator-relevant notifications from the daemon's
 * /api/status + /api/projects payloads. Surfaces:
 *
 *   - In-flight reconcile (project + file progress)
 *   - In-flight rebuilds (per project)
 *   - Watcher failures (per project, with failure reason)
 *   - Stuck rebuild_pending flags from killed daemons
 *
 * Auto-refresh: re-fetches when the SSE LiveRefresh bus signals, so
 * the bell badge updates in step with the rest of the admin UI.
 */

import type { ProjectsPayload, StatusPayload, ToolsStatusPayload } from "@shared/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLiveRefreshEvent } from "../components/live-refresh";
import { api } from "./api";

export type NotificationKind = "info" | "warn" | "error";

export interface Notification {
  /** Stable dedupe key — keeps React stable across polls. */
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  /** One-line body. Renderers may wrap. */
  readonly message: string;
  /** Optional in-app route the notification links to (e.g. `/admin`). */
  readonly href?: string;
  /** Label for the {@link href} link. */
  readonly actionLabel?: string;
}

export interface NotificationsState {
  readonly notifications: ReadonlyArray<Notification>;
  readonly loading: boolean;
}

export function useNotifications(): NotificationsState {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [projects, setProjects] = useState<ProjectsPayload | null>(null);
  const [tools, setTools] = useState<ToolsStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, p, t] = await Promise.all([api.status(), api.projects(), api.toolsStatus()]);
      setStatus(s);
      setProjects(p);
      setTools(t);
    } catch {
      // Daemon unreachable — keep the previous snapshot so the bell
      // doesn't flicker empty during a transient blip.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useLiveRefreshEvent(() => void refresh());

  return {
    notifications: deriveNotifications(status, projects, tools),
    loading,
  };
}

function deriveNotifications(
  status: StatusPayload | null,
  projects: ProjectsPayload | null,
  tools: ToolsStatusPayload | null,
): Notification[] {
  const out: Notification[] = [];

  // Optional analyzer tools enabled but not installed (info): nudge the
  // user to one-click install from Admin → Tools instead of hand-installing.
  if (tools !== null) {
    for (const t of tools.tools) {
      if (t.enabled && !t.installed) {
        out.push({
          id: `tool-missing:${t.name}`,
          kind: "info",
          title: `${t.name} is enabled but not installed`,
          message: `Install ${t.name} from Admin → Tools to activate it — loctx sets it up in its own venv and backfills your index.`,
          href: "/admin",
          actionLabel: "Install tools",
        });
      }
    }
  }

  // In-flight reconcile (warn): one entry, names the current project
  // and file progress.
  if (status !== null) {
    const r = status.reconciliation;
    if (r.running) {
      const fileLabel =
        r.currentProjectIndexed !== null && r.currentProjectTotal !== null
          ? ` — ${r.currentProjectIndexed.toLocaleString()} / ${r.currentProjectTotal.toLocaleString()} files`
          : "";
      const projectLabel = r.currentProjectName ?? "—";
      const projectProgress = `project ${r.completed + 1} of ${r.total}`;
      out.push({
        id: `reconcile:${r.startedAt ?? "unknown"}:${projectLabel}`,
        kind: "warn",
        title: `Reconciling ${projectLabel}`,
        message: `${projectProgress}${fileLabel}. Search and find_usages may return partial results until the pass finishes.`,
      });
    }
  }

  // In-flight compaction (warn): the background maintenance pass is CPU/IO
  // heavy. Surface it so an operator who notices the daemon spike knows
  // it's loctx reclaiming index disk, not a stuck process.
  if (status?.maintenance?.running) {
    out.push({
      id: `compact:${status.maintenance.startedAt ?? "unknown"}`,
      kind: "warn",
      title: "Compacting the index",
      message:
        "Merging vector fragments and pruning old version history to reclaim disk. Expect brief CPU/IO load; search stays available throughout.",
    });
  }

  if (projects === null) return out;

  // In-flight rebuilds (warn): one entry per project actively rebuilding.
  // Independent from the reconcile entry above — a rebuild can run on
  // one project while the reconciler walks another.
  for (const p of projects.active) {
    if (p.rebuilding !== null && p.rebuilding.status === "running") {
      const totals =
        p.rebuilding.totalFiles !== null
          ? `${p.rebuilding.indexed} / ${p.rebuilding.totalFiles}`
          : `${p.rebuilding.indexed}`;
      out.push({
        id: `rebuild:${p.id}:${p.rebuilding.startedAt}`,
        kind: "warn",
        title: `Rebuilding ${p.name}`,
        message: `${totals} files indexed so far. Wiping + re-embedding from scratch — the project will be unavailable for search until done.`,
      });
    }
  }

  // Watcher failures (error): per-project, names the failure reason.
  // Watcher silently stops emitting events when it errors; without
  // this signal the first sign would be stale search results hours
  // later (#160).
  for (const p of projects.active) {
    if (p.watcher === "failed") {
      out.push({
        id: `watcher-failed:${p.id}`,
        kind: "error",
        title: `Watcher failed for ${p.name}`,
        message:
          p.watcherFailure !== null
            ? `${p.watcherFailure}. Try \`ulimit -n 10240\` if it's EMFILE; otherwise click resume on /projects to retry.`
            : "Reason unknown — check daemon logs. Click resume on /projects to retry.",
      });
    }
  }

  // Stuck rebuild_pending (info): an interrupted rebuild left a marker
  // that'll trigger a forced re-index on the next reconcile pass. Surfaced
  // here so the user isn't surprised by the long pass later. Skipped
  // when the reconciler is already running — the reconcile entry above
  // already names the pending project.
  const reconcileRunning = status?.reconciliation.running ?? false;
  if (!reconcileRunning) {
    for (const p of projects.active) {
      if (
        p.rebuildPendingAt !== null &&
        (p.rebuilding === null || p.rebuilding.status !== "running")
      ) {
        out.push({
          id: `rebuild-pending:${p.id}:${p.rebuildPendingAt}`,
          kind: "info",
          title: `${p.name} flagged for rebuild`,
          message: `Rebuild was requested at ${p.rebuildPendingAt} but didn't finish. The next reconcile pass will re-run it from scratch.`,
        });
      }
    }
  }

  return out;
}
