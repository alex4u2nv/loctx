import type { OrphanRow, ProjectsRow, WatcherState } from "@shared/contracts";
import { Icon, type IconName } from "../components/icon";
import { api } from "../lib/api";
import { applyHomeAbbrev, compressPath, relativeTime } from "../lib/format";
import { useFetch } from "../lib/use-fetch";
import { useOpRunner } from "../lib/use-op-runner";

type AnyRow = ProjectsRow | OrphanRow;

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const fetched = useFetch(() => api.projects(), [refreshKey]);
  const ops = useOpRunner(() => fetched.reload());

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
    recrawl: (root: string, name: string) =>
      ops.run(`recrawl ${name}`, () => api.index(root)).then(() => undefined),
    purge: (root: string, name: string): Promise<void> => {
      if (!window.confirm(`Purge index data for ${name}? Source files untouched.`))
        return Promise.resolve();
      return ops.run(`purge ${name}`, () => api.resetProject(root)).then(() => undefined);
    },
  };

  const rootHeader = data.commonRoot !== "" ? applyHomeAbbrev(data.commonRoot, data.homeDir) : null;

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

      <h2>Active</h2>
      <ProjectsTable
        rows={data.active}
        homeDir={data.homeDir}
        commonRoot={data.commonRoot}
        emptyMessage="No projects discovered under current workspace_roots."
        actions={handlers}
        busy={ops.busy}
      />

      {data.orphaned.length > 0 ? (
        <>
          <h2>Orphaned</h2>
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
  const cols = ["project", "watcher", "indexed", "activity"];
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
                <WatcherBadge state={row.watcher} failure={row.watcherFailure} />
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

function WatcherBadge({
  state,
  failure,
}: {
  state: WatcherState | null;
  failure: string | null;
}) {
  if (state === null) return <span className="dim">—</span>;
  const cls =
    state === "active" ? "dot dot-ok" : state === "paused" ? "dot dot-warn" : "dot dot-bad";
  const iconName: IconName = state === "active" ? "play" : state === "paused" ? "pause" : "warn";
  return (
    <span className={cls} title={failure ?? undefined}>
      <Icon name={iconName} />
      <span>{state}</span>
    </span>
  );
}

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
      {actions.recrawl ? (
        <IconButton
          icon="recrawl"
          label="recrawl"
          onClick={() => void actions.recrawl?.(row.root, row.name)}
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
    </span>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="btn" onClick={onClick} disabled={disabled}>
      <Icon name={icon} /> {label}
    </button>
  );
}
