import type { InactiveRow, OrphanRow, ProjectHealth, ProjectsRow } from "@shared/contracts";
import { useCallback } from "react";
import { confirm } from "../components/confirm";
import { Icon, type IconName } from "../components/icon";
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

  const handlers = {
    pause: (id: string, name: string) =>
      ops.run(`pause ${name}`, () => api.watchPause(id)).then(() => undefined),
    resume: (id: string, name: string) =>
      ops.run(`resume ${name}`, () => api.watchResume(id)).then(() => undefined),
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
      // Rebuild is async: the endpoint returns 202 immediately and the
      // tracker drives progress via SSE. We do NOT use ops.run here
      // because that would set the global busy flag and grey out every
      // button until the server-side work finished — which can be
      // minutes on a CPU-only embedder.
      try {
        await api.rebuild(root);
        fetched.reload();
      } catch (err) {
        // Surface failures in the same banner ops.run uses, but without
        // taking the page-wide busy slot.
        ops.surfaceError(`rebuild ${name}`, err);
      }
    },
    purge: async (root: string, name: string): Promise<void> => {
      const ok = await confirm({
        title: `Purge ${name}?`,
        message: "Removes index data for this project. Source files are untouched.",
        confirmLabel: "Purge",
        danger: true,
      });
      if (!ok) return;
      await ops.run(`purge ${name}`, () => api.resetProject(root));
    },
    activate: (root: string, name: string) =>
      ops.run(`activate ${name}`, () => api.activateProject(root)).then(() => undefined),
    deactivate: (root: string, name: string) =>
      ops.run(`deactivate ${name}`, () => api.deactivateProject(root)).then(() => undefined),
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

      <h2 id="section-active">Active</h2>
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
      />

      {data.inactive.length > 0 ? (
        <>
          <h2 id="section-inactive">Inactive</h2>
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
        </>
      ) : null}

      {data.orphaned.length > 0 ? (
        <>
          <h2 id="section-orphaned">Orphaned</h2>
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
          />
        </>
      ) : null}
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
}: {
  rows: ReadonlyArray<AnyRow>;
  homeDir: string;
  commonRoot: string;
  emptyMessage: string;
  showReason?: boolean;
  actions?: RowActions;
  busy?: string | null;
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
                <div title={row.lastIndexed ?? ""}>indexed {relativeTime(row.lastIndexed)}</div>
                <div title={row.lastReconciled ?? ""}>
                  reconciled {relativeTime(row.lastReconciled)}
                </div>
              </td>
              {showReason && orphan ? (
                <td className={orphan.rootExists === false ? "err" : "warn"}>{orphan.reason}</td>
              ) : null}
              {actions !== undefined ? (
                <td>
                  <RowActionButtons row={row} actions={actions} busy={busy ?? null} />
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
      <Icon name={meta.icon} />
      <span>{meta.label}</span>
    </span>
  );
}

interface HealthMeta {
  readonly icon: IconName;
  readonly cls: string;
  readonly label: string;
}

const HEALTH_META: Record<ProjectHealth, HealthMeta> = {
  active: { icon: "play", cls: "dot-ok", label: "active" },
  ready: { icon: "ok", cls: "dot-ok", label: "ready" },
  paused: { icon: "pause", cls: "dot-warn", label: "paused" },
  "never-indexed": { icon: "warn", cls: "dot-warn", label: "never indexed" },
  empty: { icon: "warn", cls: "dot-warn", label: "no matched files" },
  errors: { icon: "warn", cls: "dot-warn", label: "errors" },
  failed: { icon: "err", cls: "dot-bad", label: "failed" },
  orphaned: { icon: "err", cls: "dot-bad", label: "orphaned" },
};

const HEALTH_FALLBACK: HealthMeta = { icon: "warn", cls: "dot-warn", label: "unknown" };

function RowActionButtons({
  row,
  actions,
  busy,
}: {
  row: AnyRow;
  actions: RowActions;
  busy: string | null;
}) {
  const isBusy = busy !== null;
  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}>
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
          label="purge"
          onClick={() => void actions.purge?.(row.root, row.name)}
          disabled={isBusy}
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

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="btn"
      onClick={onClick}
      disabled={disabled}
      {...(title !== undefined ? { title } : {})}
    >
      <Icon name={icon} /> {label}
    </button>
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
    const label =
      job.totalFiles !== null
        ? `rebuilding ${job.indexed}/${job.totalFiles}…`
        : "rebuilding…";
    return (
      <IconButton
        icon="rebuild"
        label={label}
        onClick={onClick}
        disabled
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
  // status === "done" briefly lingers; render the normal button.
  return (
    <IconButton icon="rebuild" label="rebuild" onClick={onClick} disabled={disabled} />
  );
}
