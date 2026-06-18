import type { InactiveRow, OrphanRow, ProjectHealth, ProjectsRow } from "@shared/contracts";
import { useCallback, useState } from "react";
import { confirm } from "../components/confirm";
import { Icon, type IconName } from "../components/icon";
import { IconButton } from "../components/icon-button";
import { useLiveRefreshEvent } from "../components/live-refresh";
import { type NavSection, SectionNav } from "../components/section-nav";
import { api } from "../lib/api";
import { applyHomeAbbrev, compressPath, relativeTime } from "../lib/format";
import { useFetch } from "../lib/use-fetch";
import { useOpRunner } from "../lib/use-op-runner";

type AnyRow = ProjectsRow | OrphanRow;

export function ProjectsPage() {
  const fetched = useFetch(() => api.projects(), []);
  const ops = useOpRunner(() => fetched.reload());
  const onRefresh = useCallback(() => fetched.reload(), [fetched.reload]);
  useLiveRefreshEvent(onRefresh);
  // Per-row in-flight tracker for purge. The server response takes a
  // second or two on large projects; without local UI state the row
  // looks identical between "ready" and "deleting" which made the
  // fire-and-forget refactor feel broken. Keyed by the project root
  // (the same value passed to api.resetProject) since handlers don't
  // get the row id.
  const [purgingRoots, setPurgingRoots] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  if (fetched.loading && fetched.data === null) return <p className="pullquote">Loading…</p>;
  if (fetched.error !== null)
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
        {fetched.error}
      </p>
    );
  if (fetched.data === null) return <p className="pullquote">No data.</p>;

  const data = fetched.data;
  const totals = data.active.reduce(
    (acc, row) => ({
      files: acc.files + row.files,
      chunks: acc.chunks + row.chunks,
      errors: acc.errors + row.errors,
    }),
    { files: 0, chunks: 0, errors: 0 },
  );

  // Every handler is fire-and-forget against the daemon. Earlier these
  // went through `ops.run` which set a page-wide `busy` flag and greyed
  // out every action on every row until the request finished. That made
  // sense when the actions were synchronous-by-mistake (old /api/rebuild)
  // but is hostile for genuinely fast ops (pause/resume/purge/activate/
  // deactivate) and for the now-async /api/rebuild. Each action below
  // hits the API, calls fetched.reload() on success, and surfaces any
  // error into the same banner ops.run used to write — without claiming
  // the global busy slot. Per-row state (e.g. `rebuilding`) handles
  // single-row disable when appropriate.
  const fireAndForget = async (
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await fn();
      fetched.reload();
    } catch (err) {
      ops.surfaceError(label, err);
    }
  };
  const handlers = {
    pause: (id: string, name: string): Promise<void> =>
      fireAndForget(`pause ${name}`, () => api.watchPause(id)),
    resume: (id: string, name: string): Promise<void> =>
      fireAndForget(`resume ${name}`, () => api.watchResume(id)),
    rebuild: async (root: string, name: string): Promise<void> => {
      const ok = await confirm({
        title: `Rebuild ${name}?`,
        message:
          "Clears the project's index and re-indexes from scratch. " +
          "Re-runs all enabled analyzers (lizard, duplicates, semgrep, ast-grep). " +
          "Source files are untouched. Runs in the background — embeddings can take a few minutes.",
        confirmLabel: "Rebuild",
        danger: true,
      });
      if (!ok) return;
      await fireAndForget(`rebuild ${name}`, () => api.rebuild(root));
    },
    purge: async (root: string, name: string): Promise<void> => {
      const ok = await confirm({
        title: `Purge ${name}?`,
        message: "Removes index data for this project. Source files are untouched.",
        confirmLabel: "Purge",
        danger: true,
      });
      if (!ok) return;
      // Mark this row as purging so RowActionButtons can render
      // "purging…" and disable just this row's button. Clear in the
      // finally so a failed request returns the button to its normal
      // state (along with the error banner from surfaceError).
      setPurgingRoots((s) => {
        const next = new Set(s);
        next.add(root);
        return next;
      });
      try {
        await api.resetProject(root);
        fetched.reload();
      } catch (err) {
        ops.surfaceError(`purge ${name}`, err);
      } finally {
        setPurgingRoots((s) => {
          if (!s.has(root)) return s;
          const next = new Set(s);
          next.delete(root);
          return next;
        });
      }
    },
    activate: (root: string, name: string): Promise<void> =>
      fireAndForget(`activate ${name}`, () => api.activateProject(root)),
    deactivate: (root: string, name: string): Promise<void> =>
      fireAndForget(`deactivate ${name}`, () => api.deactivateProject(root)),
  };

  const rootHeader = data.commonRoot !== "" ? applyHomeAbbrev(data.commonRoot, data.homeDir) : null;

  const navSections: NavSection[] = [{ id: "section-active", label: "Active" }];
  if (data.inactive.length > 0)
    navSections.push({ id: "section-inactive", label: "Inactive" });
  if (data.orphaned.length > 0)
    navSections.push({ id: "section-orphaned", label: "Orphaned" });

  return (
    <section>
      <span className="eyebrow">Index</span>
      <h1 className="display">Projects</h1>
      <p className="summary">
        {data.active.length} active<span className="sep">·</span>
        {totals.files} files<span className="sep">·</span>
        {totals.chunks} chunks
        {totals.errors > 0 ? (
          <>
            <span className="sep">·</span>
            <span className="err">{totals.errors} errors</span>
          </>
        ) : null}
        {data.inactive.length > 0 ? (
          <>
            <span className="sep">·</span>
            {data.inactive.length} inactive
          </>
        ) : null}
        {data.orphaned.length > 0 ? (
          <>
            <span className="sep">·</span>
            {data.orphaned.length} orphaned
          </>
        ) : null}
      </p>
      {rootHeader ? (
        <p className="summary">
          under <code>{rootHeader}</code>
        </p>
      ) : null}
      {ops.message ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--warn)" }}>
          {ops.message}
        </p>
      ) : null}

      <div className="card-stack">
        <div className="card">
          <p className="card-section-title" id="section-active">Active</p>
          <ProjectsTable
            rows={data.active}
            homeDir={data.homeDir}
            commonRoot={data.commonRoot}
            emptyMessage={
              data.inactive.length > 0
                ? "No projects activated yet — see Inactive below."
                : "No projects discovered under current workspace_roots."
            }
            actions={{
              pause: handlers.pause,
              resume: handlers.resume,
              rebuild: handlers.rebuild,
              deactivate: handlers.deactivate,
            }}
            busy={ops.busy}
            purgingRoots={purgingRoots}
          />
        </div>

        {data.inactive.length > 0 ? (
          <div className="card">
            <p className="card-section-title" id="section-inactive">Inactive</p>
            <p className="summary">
              Discovered under <code>workspace_roots</code> but not yet indexed. Activating runs an
              initial index pass and registers the watcher.
            </p>
            <InactiveTable
              rows={data.inactive}
              homeDir={data.homeDir}
              commonRoot={data.commonRoot}
              onActivate={handlers.activate}
              busy={ops.busy}
            />
          </div>
        ) : null}

        {data.orphaned.length > 0 ? (
          <div className="card">
            <p className="card-section-title" id="section-orphaned">Orphaned</p>
            <p className="summary">
              Indexed previously but no longer maintained. <code>purge</code> removes their data;
              restoring <code>workspace_roots</code> brings them back as active.
            </p>
            <ProjectsTable
              rows={data.orphaned}
              homeDir={data.homeDir}
              commonRoot={data.commonRoot}
              emptyMessage=""
              showReason
              actions={{ purge: handlers.purge }}
              busy={ops.busy}
              purgingRoots={purgingRoots}
            />
          </div>
        ) : null}
      </div>
      <SectionNav sections={navSections} />
    </section>
  );
}

interface RowActions {
  readonly pause?: (id: string, name: string) => Promise<void>;
  readonly resume?: (id: string, name: string) => Promise<void>;
  readonly rebuild?: (root: string, name: string) => Promise<void>;
  readonly purge?: (root: string, name: string) => Promise<void>;
  readonly deactivate?: (root: string, name: string) => Promise<void>;
}

function ProjectsTable({
  rows,
  homeDir,
  commonRoot,
  emptyMessage,
  showReason,
  actions,
  busy,
  purgingRoots,
}: {
  rows: ReadonlyArray<AnyRow>;
  homeDir: string;
  commonRoot: string;
  emptyMessage: string;
  showReason?: boolean;
  actions?: RowActions;
  busy?: string | null;
  purgingRoots?: ReadonlySet<string>;
}) {
  const cols = ["project", "status", "indexed", "activity"];
  if (showReason) cols.push("reason");
  if (actions !== undefined) cols.push("actions");

  return (
    <table className="data-table">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const orphan = "rootExists" in row ? row : null;
          const displayPath = compressPath(row.root, homeDir, commonRoot);
          return (
            <tr key={row.id}>
              <td>
                <div title={`${row.id} · ${row.root}`}>
                  <strong>{row.name}</strong>
                  <span className="dim">
                    {row.marker !== null ? ` [${row.marker}]` : ""}
                  </span>
                  {row.absorbedMarkers.length > 0 ? (
                    <AbsorbedMarkersPill markers={row.absorbedMarkers} />
                  ) : null}
                </div>
                <div
                  className={orphan?.rootExists === false ? "err" : "dim"}
                  style={{ fontSize: "0.85em" }}
                >
                  {displayPath}
                </div>
              </td>
              <td>
                <HealthBadge health={row.health} hint={row.healthHint} />
              </td>
              <td>
                <div className="num">{row.files} files</div>
                <div className="num dim" style={{ fontSize: "0.85em" }}>
                  {row.chunks} chunks
                  {row.errors > 0 ? (
                    <span className="err"> · {row.errors} errors</span>
                  ) : null}
                </div>
              </td>
              <td className="dim" style={{ fontSize: "0.9em" }}>
                <IndexStatusCell row={row} />
              </td>
              {showReason && orphan ? (
                <td className={orphan.rootExists === false ? "err" : "warn"}>{orphan.reason}</td>
              ) : null}
              {actions !== undefined ? (
                <td>
                  <RowActionButtons
                    row={row}
                    actions={actions}
                    busy={busy ?? null}
                    isPurging={purgingRoots?.has(row.root) ?? false}
                  />
                </td>
              ) : null}
            </tr>
          );
        })}
        {rows.length === 0 && emptyMessage !== "" ? (
          <tr>
            <td
              colSpan={cols.length}
              style={{ color: "var(--subtle)", textAlign: "center", padding: "var(--space-5)" }}
            >
              {emptyMessage}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

/**
 * Per-row "indexing/indexed · reconciling/reconciled" cell. Splits the
 * stale-timestamp display into honest in-flight vs completed states so
 * the user can tell at a glance whether work is happening right now.
 *
 *   In-flight rebuild:   "indexing… N files"     (no stamp shown)
 *   No rebuild:          "indexed Xs ago"        (past-tense stamp)
 *   Mid-reconcile here:  "reconciling… N/M files"
 *   Not mid-reconcile:   "reconciled Xs ago" or "reconciled —"
 */
function IndexStatusCell({ row }: { row: AnyRow }) {
  // The /api/rebuild path uses RebuildProgress; if a rebuild is running,
  // the indexer is actively writing rows for this project.
  const isIndexing = row.rebuilding !== null && row.rebuilding.status === "running";
  const indexedLabel = isIndexing ? (
    <span className="warn">
      indexing… {row.rebuilding?.indexed ?? 0}
      {row.rebuilding?.totalFiles !== null && row.rebuilding?.totalFiles !== undefined
        ? `/${row.rebuilding.totalFiles}`
        : ""}{" "}
      files
    </span>
  ) : (
    <>indexed {relativeTime(row.lastIndexed)}</>
  );

  const isReconciling = row.reconciling !== null;
  const reconcileLabel = isReconciling ? (
    <span className="warn">
      reconciling…{" "}
      {row.reconciling?.indexed !== null && row.reconciling?.total !== null
        ? `${row.reconciling.indexed.toLocaleString()} / ${row.reconciling.total.toLocaleString()} files`
        : "walking"}
    </span>
  ) : (
    <>reconciled {relativeTime(row.lastReconciled)}</>
  );

  return (
    <>
      <div title={isIndexing ? "in-flight rebuild" : (row.lastIndexed ?? "")}>{indexedLabel}</div>
      <div title={isReconciling ? "in-flight reconcile" : (row.lastReconciled ?? "")}>
        {reconcileLabel}
      </div>
    </>
  );
}

function AbsorbedMarkersPill({
  markers,
}: {
  markers: ReadonlyArray<ProjectsRow["absorbedMarkers"][number]>;
}) {
  const count = markers.length;
  const label = `${count} inner ${count === 1 ? "marker" : "markers"}`;
  const summary = markers.map((m) => `${m.relPath} (${m.marker})`).join("\n");
  return (
    <details className="absorbed-pill">
      <summary title={summary}>{label}</summary>
      <ul>
        {markers.map((m) => (
          <li key={m.relPath}>
            <code>{m.relPath}</code>
            <span className="dim"> · {m.marker}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function HealthBadge({
  health,
  hint,
}: {
  health: ProjectHealth | null | undefined;
  hint: string | null | undefined;
}) {
  // Defensive: a daemon on an older build can return rows without
  // `health`. Fall back to a neutral badge rather than crashing the
  // page when the meta lookup misses.
  const meta = (health !== null && health !== undefined && HEALTH_META[health]) || HEALTH_FALLBACK;
  return (
    <span className={`dot ${meta.cls}`} title={hint ?? undefined}>
      <Icon name={meta.icon} animate={meta.animate === true} />
      <span>{meta.label}</span>
    </span>
  );
}

interface HealthMeta {
  readonly icon: IconName;
  readonly cls: string;
  readonly label: string;
  /** Pulse the icon — used for transient in-flight states. */
  readonly animate?: boolean;
}

const HEALTH_META: Record<ProjectHealth, HealthMeta> = {
  active: { icon: "play", cls: "dot-ok", label: "active" },
  ready: { icon: "ok", cls: "dot-ok", label: "ready" },
  paused: { icon: "pause", cls: "dot-warn", label: "paused" },
  "never-indexed": { icon: "warn", cls: "dot-warn", label: "never indexed" },
  empty: { icon: "warn", cls: "dot-warn", label: "no matched files" },
  errors: { icon: "warn", cls: "dot-warn", label: "errors" },
  indexing: { icon: "rebuild", cls: "dot-busy", label: "indexing", animate: true },
  reconciling: { icon: "refresh", cls: "dot-busy", label: "reconciling", animate: true },
  failed: { icon: "err", cls: "dot-bad", label: "failed" },
  orphaned: { icon: "err", cls: "dot-bad", label: "orphaned" },
};

const HEALTH_FALLBACK: HealthMeta = { icon: "warn", cls: "dot-warn", label: "unknown" };

function RowActionButtons({
  row,
  actions,
  busy,
  isPurging,
}: {
  row: AnyRow;
  actions: RowActions;
  busy: string | null;
  isPurging: boolean;
}) {
  const isBusy = busy !== null;
  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}>
      <IconButton
        icon="search"
        label="inspect"
        href={`/projects/${encodeURIComponent(row.id)}`}
        title="Inspect: view stats and scoped search/find-usages for this project"
      />
      {actions.pause && row.watcher === "active" ? (
        <IconButton
          icon="pause"
          label="pause"
          onClick={() => void actions.pause?.(row.id, row.name)}
          disabled={isBusy}
        />
      ) : null}
      {actions.resume && (row.watcher === "paused" || row.watcher === "failed") ? (
        <IconButton
          icon="play"
          label="resume"
          onClick={() => void actions.resume?.(row.id, row.name)}
          disabled={isBusy}
        />
      ) : null}
      {actions.rebuild ? (
        <RebuildButton
          row={row}
          onClick={() => void actions.rebuild?.(row.root, row.name)}
          disabled={isBusy}
        />
      ) : null}
      {actions.purge ? (
        <IconButton
          icon="purge"
          label={isPurging ? "purging…" : "purge"}
          onClick={() => void actions.purge?.(row.root, row.name)}
          disabled={isBusy || isPurging}
          {...(isPurging
            ? {
                title:
                  "Purge in progress — clearing this project's vectors + state from disk. The row will disappear once it completes.",
              }
            : {})}
        />
      ) : null}
      {actions.deactivate ? (
        <IconButton
          icon="pause"
          label="deactivate"
          onClick={async () => {
            const ok = await confirm({
              title: `Deactivate ${row.name}?`,
              message:
                "Watcher stops and indexing pauses. Indexed data stays — use purge to remove it.",
              confirmLabel: "Deactivate",
            });
            if (!ok) return;
            void actions.deactivate?.(row.root, row.name);
          }}
          disabled={isBusy}
        />
      ) : null}
    </span>
  );
}

function InactiveTable({
  rows,
  homeDir,
  commonRoot,
  onActivate,
  busy,
}: {
  rows: ReadonlyArray<InactiveRow>;
  homeDir: string;
  commonRoot: string;
  onActivate: (root: string, name: string) => Promise<void>;
  busy: string | null;
}) {
  const isBusy = busy !== null;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>project</th>
          <th>marker</th>
          <th>state</th>
          <th>actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const displayPath = compressPath(row.root, homeDir, commonRoot);
          return (
            <tr key={row.id}>
              <td>
                <div title={`${row.id} · ${row.root}`}>
                  <strong>{row.name}</strong>
                </div>
                <div className="dim" style={{ fontSize: "0.85em" }}>
                  {displayPath}
                </div>
              </td>
              <td className="dim">
                {row.marker !== null
                  ? `${row.marker}${row.markerKind !== null ? ` (${row.markerKind})` : ""}`
                  : "—"}
              </td>
              <td className="dim">{row.known ? "deactivated" : "never activated"}</td>
              <td>
                <IconButton
                  icon="play"
                  label="activate"
                  onClick={() => void onActivate(row.root, row.name)}
                  disabled={isBusy}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Rebuild action button that reflects the per-row tracker state from
 * `/api/projects`. When a rebuild is in flight, the button shows
 * progress text and self-disables so the user doesn't double-fire.
 * Other rows' buttons stay enabled — the page is never globally greyed
 * for a rebuild (#XYZ).
 */
function RebuildButton({
  row,
  onClick,
  disabled,
}: {
  row: AnyRow;
  onClick: () => void;
  disabled: boolean;
}) {
  const job = row.rebuilding;
  if (job !== null && job.status === "running") {
    const eta = estimateEta(job);
    const counts =
      job.totalFiles !== null ? `${job.indexed}/${job.totalFiles}` : null;
    const label =
      counts === null
        ? "rebuilding"
        : eta !== null
          ? `rebuilding ${counts} (~${eta} left)`
          : `rebuilding ${counts}`;
    return (
      <IconButton
        icon="rebuild"
        label={label}
        onClick={onClick}
        disabled
        animate
        title="Rebuild in progress — runs in the background; the page will refresh as the indexer makes progress."
      />
    );
  }
  if (job !== null && job.status === "failed") {
    return (
      <IconButton
        icon="warn"
        label="rebuild failed"
        onClick={onClick}
        disabled={disabled}
        title={job.error ?? "Rebuild failed. Click to retry."}
      />
    );
  }
  // No in-memory tracker entry, but the project carries a persisted
  // rebuild_pending_at — its rebuild was interrupted by a daemon stop
  // and the startup reconciler is finishing the work right now. Same
  // "rebuilding" label + animated hammer as the running case; the
  // animation is the signal that work is happening, no need for a
  // distinct "resuming" word.
  if (job === null && row.rebuildPendingAt !== null) {
    return (
      <IconButton
        icon="rebuild"
        label="rebuilding"
        onClick={onClick}
        disabled
        animate
        title={`Rebuild requested at ${row.rebuildPendingAt}; the daemon restart left this project queued for the next reconcile pass.`}
      />
    );
  }
  // status === "done" briefly lingers; render the normal button.
  return (
    <IconButton icon="rebuild" label="rebuild" onClick={onClick} disabled={disabled} />
  );
}

/**
 * Linear extrapolation: ms-per-file from observed progress × files left.
 * Returns null until we have enough data to be meaningful — first few
 * files often have skewed timings (chunker warmup, embedder JIT) and a
 * 10s "ETA: 2h" jolt is worse than no ETA.
 */
function estimateEta(job: {
  readonly indexed: number;
  readonly totalFiles: number | null;
  readonly startedAt: number;
}): string | null {
  if (job.totalFiles === null || job.totalFiles === 0) return null;
  if (job.indexed < 3) return null; // warmup window
  if (job.indexed >= job.totalFiles) return null;
  const elapsedMs = Date.now() - job.startedAt;
  if (elapsedMs < 5_000) return null;
  const msPerFile = elapsedMs / job.indexed;
  const remaining = job.totalFiles - job.indexed;
  return formatDuration(Math.round(msPerFile * remaining));
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return "<1m";
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
