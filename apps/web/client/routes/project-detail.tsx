/**
 * `/projects/:id` inspect view.
 *
 * Header: name + root + health.
 * Stats: byExtension table, topFiles, recentFiles, failingFiles.
 * Tabs: scoped search + scoped find-usages. Both reuse the existing
 * `/api/search` and `/api/find-usages` endpoints with `path` pre-set
 * to the project root, so we don't fork the retrieval code path.
 *
 * Loads from `GET /api/projects/:id`. 404 routes back to /projects.
 */

import type {
  FindUsagesPayload,
  ProjectDetailPayload,
  SearchHit,
  SearchPayload,
  UsageHit,
} from "@shared/contracts";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BarChart, type BarRow } from "../components/bar-chart";
import { type Column, DataTable } from "../components/data-table";
import { useLiveRefreshEvent } from "../components/live-refresh";
import { QueryForm } from "../components/query-form";
import { SnippetModal } from "../components/snippet-modal";
import { SurfaceCard } from "../components/surface-card";
import { useSnippetSelection } from "../lib/use-snippet-selection";
import { api } from "../lib/api";
import { compressPath, relativeTime } from "../lib/format";
import { useFetch } from "../lib/use-fetch";

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  // The page hard-requires an id segment; absent means the route
  // pattern didn't match (defensive, shouldn't happen with React Router).
  const safeId = id ?? "";
  const fetched = useFetch(
    () => (safeId === "" ? Promise.reject(new Error("no project id")) : api.projectDetail(safeId)),
    [safeId],
  );
  // Stats can drift as the watcher / reconciler indexes files; reload
  // on any SSE event so file counts + recent files stay live.
  useLiveRefreshEvent(fetched.reload);

  if (fetched.loading && fetched.data === null) return <p className="pullquote">Loading…</p>;
  if (fetched.error !== null)
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
        {fetched.error}
        <br />
        <Link to="/projects">← back to projects</Link>
      </p>
    );
  if (fetched.data === null) return <p className="pullquote">No data.</p>;

  const { project, stats } = fetched.data;
  const TOP_N = 8;
  const compactByExt = stats.byExtension.slice(0, TOP_N);
  const compactTopFiles = stats.topFiles.slice(0, TOP_N);
  return (
    <section>
      <p className="summary">
        <Link to="/projects">← projects</Link>
      </p>
      {/* Header row: project meta on the left, compact charts on the right.
          flex-wrap means narrow screens stack rather than crushing the
          charts. Charts are rendered ahead of the search box because
          search results push the page down. */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-4)",
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <span className="eyebrow">Inspect</span>
          <h1 className="display">{project.name}</h1>
          <p className="summary">
            <code title={project.id}>{project.root}</code>
          </p>
          <p className="summary">
            {project.files} files<span className="sep">·</span>
            {project.chunks} chunks
            {project.errors > 0 ? (
              <>
                <span className="sep">·</span>
                <span className="err">{project.errors} errors</span>
              </>
            ) : null}
            <span className="sep">·</span>
            <span className="dim">indexed {relativeTime(project.lastIndexed)}</span>
            <span className="sep">·</span>
            <span className="dim">reconciled {relativeTime(project.lastReconciled)}</span>
          </p>
          <p className="summary dim">{project.healthHint}</p>
        </div>
        <div
          style={{
            flex: "2 1 480px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "var(--space-3)",
          }}
        >
          <SurfaceCard
            eyebrow="Composition"
            subtitle={`chunks by extension${stats.byExtension.length > TOP_N ? ` (top ${TOP_N} of ${stats.byExtension.length})` : ""}`}
          >
            <BarChart rows={byExtensionRows(compactByExt)} />
          </SurfaceCard>
          <SurfaceCard
            eyebrow="Top files"
            subtitle={`by chunk count${stats.topFiles.length > TOP_N ? ` (top ${TOP_N})` : ""}`}
          >
            <BarChart rows={topFileRows(compactTopFiles)} />
          </SurfaceCard>
        </div>
      </div>

      <ScopedSearchPanel projectRoot={project.root} />

      <h2>Recently indexed</h2>
      <FilesTable rows={stats.recentFiles} kind="recent" />

      {stats.failingFiles.length > 0 ? (
        <>
          <h2>Files with errors ({stats.failingFiles.length})</h2>
          <FailingTable rows={stats.failingFiles} />
        </>
      ) : null}
    </section>
  );
}

// ---- chart row builders ------------------------------------------------

function byExtensionRows(rows: ProjectDetailPayload["stats"]["byExtension"]): BarRow[] {
  return rows.map((r) => ({
    key: r.ext,
    label: r.ext,
    value: r.chunks,
    hint: `${r.files} file${r.files === 1 ? "" : "s"}`,
    title: `${r.ext}: ${r.files} file${r.files === 1 ? "" : "s"}, ${r.chunks} chunks`,
  }));
}

function topFileRows(rows: ProjectDetailPayload["stats"]["topFiles"]): BarRow[] {
  return rows.map((r) => ({
    key: r.relPath,
    label: r.relPath,
    value: r.chunks,
    title: r.relPath,
  }));
}

// ---- recent / failing tables -------------------------------------------

type FileRow =
  | ProjectDetailPayload["stats"]["topFiles"][number]
  | ProjectDetailPayload["stats"]["recentFiles"][number];

function FilesTable({
  rows,
  kind,
}: {
  rows: ReadonlyArray<FileRow>;
  kind: "top" | "recent";
}) {
  if (rows.length === 0) return <p className="pullquote">—</p>;
  const columns: Column<FileRow>[] = [
    { key: "file", header: "file", cell: (r) => <code>{r.relPath}</code> },
  ];
  if (kind === "top") {
    columns.push({
      key: "chunks",
      header: "chunks",
      numeric: true,
      cell: (r) => ("chunks" in r ? r.chunks : ""),
    });
  }
  columns.push({
    key: "indexed",
    header: "indexed",
    dim: true,
    headerClassName: "dim",
    cell: (r) => <span title={r.indexedAt ?? ""}>{relativeTime(r.indexedAt)}</span>,
  });
  return <DataTable rows={rows} rowKey={(r) => r.relPath} columns={columns} />;
}

function FailingTable({ rows }: { rows: ProjectDetailPayload["stats"]["failingFiles"] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.relPath}
      columns={[
        { key: "file", header: "file", cell: (r) => <code>{r.relPath}</code> },
        {
          key: "error",
          header: "error",
          cell: (r) => <span className="err">{r.error}</span>,
        },
      ]}
    />
  );
}

// ---- scoped search / find-usages panel ---------------------------------

type Tab = "search" | "find-usages";

function ScopedSearchPanel({ projectRoot }: { projectRoot: string }) {
  const [tab, setTab] = useState<Tab>("search");
  return (
    <>
      <h2>Query this project</h2>
      <div
        role="tablist"
        style={{ display: "inline-flex", gap: "0.5rem", marginBottom: "var(--space-3)" }}
      >
        <TabButton active={tab === "search"} onClick={() => setTab("search")}>
          search
        </TabButton>
        <TabButton active={tab === "find-usages"} onClick={() => setTab("find-usages")}>
          find-usages
        </TabButton>
      </div>
      {tab === "search" ? (
        <ScopedSearch projectRoot={projectRoot} />
      ) : (
        <ScopedFindUsages projectRoot={projectRoot} />
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className="btn"
      onClick={onClick}
      style={{
        borderColor: active ? "var(--accent)" : undefined,
      }}
    >
      {children}
    </button>
  );
}

function ScopedSearch({ projectRoot }: { projectRoot: string }) {
  const [results, setResults] = useState<SearchPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (query: string): Promise<void> => {
    if (query === "") return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.search({ query, path: projectRoot, limit: 25 });
      setResults(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <QueryForm
        busy={busy}
        submitLabel="Search"
        fields={[
          {
            id: "scoped-search-q",
            name: "q",
            label: "query",
            placeholder: "semantic + lexical search across this project",
          },
        ]}
        onSubmit={(values) => void submit(values["q"] ?? "")}
      />
      {error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : null}
      {results !== null ? <SearchResults hits={results.results} /> : null}
    </>
  );
}

function SearchResults({ hits }: { hits: ReadonlyArray<SearchHit> }) {
  const { selected, open, close } = useSnippetSelection<SearchHit>();
  if (hits.length === 0) return <p className="pullquote">No matches.</p>;
  return (
    <>
      <p className="summary dim">
        {hits.length} {hits.length === 1 ? "result" : "results"}. Click a row for the snippet.
      </p>
      <DataTable
        rows={hits}
        rowKey={(h, i) => `${h.relPath}-${h.startLine}-${i}`}
        onRowClick={open}
        columns={[
          { key: "file", header: "file", cell: (h) => <code>{h.relPath}</code> },
          {
            key: "lines",
            header: "lines",
            numeric: true,
            cell: (h) => `${h.startLine}-${h.endLine}`,
          },
          { key: "kind", header: "kind", dim: true, cell: (h) => h.kind },
          {
            key: "score",
            header: "score",
            numeric: true,
            cell: (h) => h.score.toFixed(3),
          },
        ]}
      />
      {selected !== null ? (
        <SnippetModal
          title={selected.relPath}
          snippet={selected.snippet}
          onClose={close}
          meta={<SearchHitMeta hit={selected} />}
          {...(selected.language !== "" ? { language: selected.language } : {})}
        />
      ) : null}
    </>
  );
}

function SearchHitMeta({ hit }: { hit: SearchHit }) {
  return (
    <>
      <span className="dim">
        lines {hit.startLine}-{hit.endLine}
        <span className="sep">·</span>
        {hit.language || "—"}
        <span className="sep">·</span>
        {hit.kind}
        <span className="sep">·</span>
        score {hit.score.toFixed(3)}
      </span>
      {hit.symbols.length > 0 ? (
        <>
          <br />
          <span className="dim">symbols: {hit.symbols.join(", ")}</span>
        </>
      ) : null}
      {hit.matchReasons.length > 0 ? (
        <>
          <br />
          <span className="dim">matched: {hit.matchReasons.join(", ")}</span>
        </>
      ) : null}
    </>
  );
}

function ScopedFindUsages({ projectRoot }: { projectRoot: string }) {
  const [results, setResults] = useState<FindUsagesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (symbol: string): Promise<void> => {
    if (symbol === "") return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.findUsages({ symbol, path: projectRoot });
      setResults(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <QueryForm
        busy={busy}
        submitLabel="Find"
        fields={[
          {
            id: "scoped-fu-sym",
            name: "sym",
            label: "symbol",
            placeholder: "exact-match symbol name (e.g. authenticate)",
          },
        ]}
        onSubmit={(values) => void submit(values["sym"] ?? "")}
      />
      {error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : null}
      {results !== null ? (
        <UsageResults defs={results.defs} refs={results.refs} symbol={results.symbol} />
      ) : null}
    </>
  );
}

function UsageResults({
  defs,
  refs,
  symbol,
}: {
  defs: ReadonlyArray<UsageHit>;
  refs: ReadonlyArray<UsageHit>;
  symbol: string;
}) {
  if (defs.length === 0 && refs.length === 0)
    return <p className="pullquote">No matches for {symbol}.</p>;
  return (
    <>
      <h3>Definitions ({defs.length})</h3>
      <UsageTable hits={defs} />
      <h3>References ({refs.length})</h3>
      <UsageTable hits={refs} />
    </>
  );
}

function UsageTable({ hits }: { hits: ReadonlyArray<UsageHit> }) {
  const { selected, open, close } = useSnippetSelection<UsageHit>();
  if (hits.length === 0) return <p className="pullquote">none</p>;
  return (
    <>
      <DataTable
        rows={hits}
        rowKey={(h, i) => `${h.projectId}-${h.relPath}-${h.chunkStartLine}-${i}`}
        onRowClick={open}
        columns={[
          { key: "file", header: "file", cell: (h) => <code>{h.relPath}</code> },
          { key: "kind", header: "kind", dim: true, cell: (h) => h.kind },
          {
            key: "lines",
            header: "lines",
            numeric: true,
            cell: (h) => `${h.chunkStartLine}-${h.chunkEndLine}`,
          },
        ]}
      />
      {selected !== null ? (
        <SnippetModal
          title={selected.relPath}
          snippet={selected.snippet}
          onClose={close}
          meta={
            <span className="dim">
              lines {selected.chunkStartLine}-{selected.chunkEndLine}
              <span className="sep">·</span>
              kind: {selected.kind}
            </span>
          }
        />
      ) : null}
    </>
  );
}

// Avoid unused-import warnings — `compressPath` is intentionally not
// used here (the inspect view shows the full root), but exporting an
// inline alias guarantees the tree-shaken bundle is identical regardless
// of whether a future iteration starts using it.
void compressPath;
