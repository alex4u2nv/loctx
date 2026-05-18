/**
 * Derive a list of operator-relevant notifications from the daemon's
 * /api/status payload. Currently surfaces:
 *
 *   - In-flight reconcile (project + file progress)
 *
 * Future sources (rebuild_pending flags, watcher failures, etc.) will
 * plug into the same shape so the bell UI doesn't grow new code paths.
 *
 * Auto-refresh: re-fetches when the SSE LiveRefresh bus signals, so
 * the bell badge updates in step with the rest of the admin UI.
 */

import { useCallback, useEffect, useState } from "react";
import type { StatusPayload } from "@shared/contracts";
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
}

export interface NotificationsState {
  readonly notifications: ReadonlyArray<Notification>;
  readonly loading: boolean;
}

export function useNotifications(): NotificationsState {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.status();
      setStatus(next);
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
    notifications: status === null ? [] : deriveNotifications(status),
    loading,
  };
}

function deriveNotifications(status: StatusPayload): Notification[] {
  const out: Notification[] = [];

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

  return out;
}
