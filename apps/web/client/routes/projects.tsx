import type { OrphanRow, ProjectsRow } from "@shared/contracts";
import { useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const { data, error, loading, reload } = useFetch(() => api.projects(), [refreshKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const op = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      setMessage(`${label}: ok`);
      reload();
    } catch (e) {
      setMessage(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handlers = {
    pause: (id: string, name: string) => op(`pause ${name}`, () => api.watchPause(id)),
    resume: (id: string, name: string) => op(`resume ${name}`, () => api.watchResume(id)),
    recrawl: (root: string, name: string) => op(`recrawl ${name}`, () => api.index(root)),
    purge: (root: string, name: string) => {
      if (!window.confirm(`Purge index data for ${name}? Source files untouched.`))
        return Promise.resolve();
      return op(`purge ${name}`, () => api.resetProject(root));
    },
  };

  if (loading && data === null) return <p className="pullquote">Loading…</p>;
  if (error !== null)
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
        {error}
      </p>
    );
  if (data === null) return <p className="pullquote">No data.</p>;

  const totals = data.active.reduce(
    (acc, row) => ({
      files: acc.files + row.files,
      chunks: acc.chunks + row.chunks,
      errors: acc.errors + row.errors,
    }),
    { files: 0, chunks: 0, errors: 0 },
  );

  return (
    <section>
      <span className="eyebrow">Index</span>
      <h1 className="display">Projects</h1>
      <p className="summary">
        {data.active.length} active<span className="sep">·</span>
        {totals.files} files indexed<span className="sep">·</span>
        {totals.chunks} chunks<span className="sep">·</span>
        {totals.errors} errors
        {data.orphaned.length > 0 ? (
          <>
            <span className="sep">·</span>
            {data.orphaned.length} orphaned
          </>
        ) : null}
      </p>
      {message ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--warn)" }}>
          {message}
        </p>
      ) : null}

      <h2>Active</h2>
      <ProjectsTable
        rows={data.active}
        emptyMessage="No projects discovered under current workspace_roots."
        actions={handlers}
        busy={busy}
      />

      {data.orphaned.length > 0 ? (
        <>
          <h2>Orphaned</h2>
          <p className="summary">
            Indexed previously but no longer maintained. <code>purge</code> removes their data;{" "}
            <code>workspace_roots</code> can also restore them as active.
          </p>
          <ProjectsTable
            rows={data.orphaned}
            emptyMessage=""
            showReason
            actions={{ purge: handlers.purge }}
            busy={busy}
          />
        </>
      ) : null}
    </section>
  );
}

interface RowActions {
  readonly pause?: (id: string, name: string) => Promise<void>;
  readonly resume?: (id: string, name: string) => Promise<void>;
  readonly recrawl?: (root: string, name: string) => Promise<void>;
  readonly purge?: (root: string, name: string) => Promise<void>;
}

function ProjectsTable({
  rows,
  emptyMessage,
  showReason,
  actions,
  busy,
}: {
  rows: ReadonlyArray<ProjectsRow | OrphanRow>;
  emptyMessage: string;
  showReason?: boolean;
  actions?: RowActions;
  busy?: string | null;
}) {
  const baseCols = 10 + (actions !== undefined ? 1 : 0);
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>id</th>
          <th>name</th>
          <th>root</th>
          <th>marker</th>
          <th>watcher</th>
          <th className="num">files</th>
          <th className="num">chunks</th>
          <th className="num">errors</th>
          <th>last indexed</th>
          <th>last reconciled</th>
          {showReason ? <th>reason</th> : null}
          {actions !== undefined ? <th>actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const orphan = "rootExists" in row ? row : null;
          return (
            <tr key={row.id}>
              <td className="dim">{row.id}</td>
              <td>{row.name}</td>
              <td className={orphan?.rootExists === false ? "err" : "dim"}>{row.root}</td>
              <td className="dim">
                {row.marker !== null
                  ? `${row.marker}${row.markerKind !== null ? ` (${row.markerKind})` : ""}`
                  : "—"}
              </td>
              <td>
                <WatcherBadge state={row.watcher} failure={row.watcherFailure} />
              </td>
              <td className="num">{row.files}</td>
              <td className="num">{row.chunks}</td>
              <td className={`num ${row.errors > 0 ? "err" : ""}`}>{row.errors}</td>
              <td className="dim">
                {row.lastIndexed ? new Date(row.lastIndexed).toLocaleString() : "—"}
              </td>
              <td className="dim">
                {row.lastReconciled ? new Date(row.lastReconciled).toLocaleString() : "never"}
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
              colSpan={baseCols + (showReason ? 1 : 0)}
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

function WatcherBadge({
  state,
  failure,
}: {
  state: ProjectsRow["watcher"];
  failure: string | null;
}) {
  if (state === null) return <span className="dim">—</span>;
  const label = state;
  const className = state === "active" ? "dot dot-ok" : state === "paused" ? "dot dot-warn" : "dot dot-bad";
  return (
    <span className={className} title={failure ?? undefined}>
      <span className="dot-mark" />
      <span>{label}</span>
    </span>
  );
}

function RowActionButtons({
  row,
  actions,
  busy,
}: {
  row: ProjectsRow | OrphanRow;
  actions: RowActions;
  busy: string | null;
}) {
  const isBusy = busy !== null;
  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}>
      {actions.pause && row.watcher === "active" ? (
        <button
          type="button"
          className="btn"
          onClick={() => void actions.pause?.(row.id, row.name)}
          disabled={isBusy}
        >
          pause
        </button>
      ) : null}
      {actions.resume && (row.watcher === "paused" || row.watcher === "failed") ? (
        <button
          type="button"
          className="btn"
          onClick={() => void actions.resume?.(row.id, row.name)}
          disabled={isBusy}
        >
          resume
        </button>
      ) : null}
      {actions.recrawl ? (
        <button
          type="button"
          className="btn"
          onClick={() => void actions.recrawl?.(row.root, row.name)}
          disabled={isBusy}
        >
          recrawl
        </button>
      ) : null}
      {actions.purge ? (
        <button
          type="button"
          className="btn"
          onClick={() => void actions.purge?.(row.root, row.name)}
          disabled={isBusy}
        >
          purge
        </button>
      ) : null}
    </span>
  );
}
