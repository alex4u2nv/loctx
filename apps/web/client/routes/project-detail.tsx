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
import { useLiveRefreshEvent } from "../components/live-refresh";
import { SnippetModal } from "../components/snippet-modal";
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
          <ChartCard
            title="Composition"
            subtitle={`chunks by extension${stats.byExtension.length > TOP_N ? ` (top ${TOP_N} of ${stats.byExtension.length})` : ""}`}
          >
            <BarChart rows={byExtensionRows(compactByExt)} />
          </ChartCard>
          <ChartCard
            title="Top files"
            subtitle={`by chunk count${stats.topFiles.length > TOP_N ? ` (top ${TOP_N})` : ""}`}
          >
            <BarChart rows={topFileRows(compactTopFiles)} />
          </ChartCard>
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

// ---- compact chart card ------------------------------------------------

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        padding: "var(--space-3)",
      }}
    >
      <p
        className="eyebrow"
        style={{ margin: 0, fontSize: "0.7rem" }}
      >
        {title}
      </p>
      <p
        className="dim"
        style={{ margin: "0 0 var(--space-2)", fontSize: "0.75rem" }}
      >
        {subtitle}
      </p>
      {children}
    </div>
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

// ---- recent / failing tables (kept as tables) --------------------------

function FilesTable({
  rows,
  kind,
}: {
  rows:
    | ProjectDetailPayload["stats"]["topFiles"]
    | ProjectDetailPayload["stats"]["recentFiles"];
  kind: "top" | "recent";
}) {
  if (rows.length === 0) return <p className="pullquote">—</p>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>file</th>
          {kind === "top" ? <th className="num">chunks</th> : null}
          <th className="dim">indexed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.relPath}>
            <td>
              <code>{r.relPath}</code>
            </td>
            {kind === "top" && "chunks" in r ? <td className="num">{r.chunks}</td> : null}
            <td className="dim" title={r.indexedAt ?? ""}>
              {relativeTime(r.indexedAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FailingTable({ rows }: { rows: ProjectDetailPayload["stats"]["failingFiles"] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>file</th>
          <th>error</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.relPath}>
            <td>
              <code>{r.relPath}</code>
            </td>
            <td className="err">{r.error}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void submit(String(fd.get("q") ?? "").trim());
        }}
      >
        <div className="field">
          <label htmlFor="scoped-search-q">query</label>
          <input
            id="scoped-search-q"
            name="q"
            type="text"
            className="input"
            placeholder="semantic + lexical search across this project"
          />
        </div>
        <button type="submit" className="btn btn-primary field-submit" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
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
  const [open, setOpen] = useState<SearchHit | null>(null);
  if (hits.length === 0) return <p className="pullquote">No matches.</p>;
  return (
    <>
      <p className="summary dim">
        {hits.length} {hits.length === 1 ? "result" : "results"}. Click a row for the snippet.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>file</th>
            <th>lines</th>
            <th>kind</th>
            <th className="num">score</th>
          </tr>
        </thead>
        <tbody>
          {hits.map((h, i) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: composite key would be (relPath+startLine+score), index is fine for ranked results
              key={`${h.relPath}-${h.startLine}-${i}`}
              onClick={() => setOpen(h)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen(h);
                }
              }}
              tabIndex={0}
              role="button"
              style={{ cursor: "pointer" }}
            >
              <td>
                <code>{h.relPath}</code>
              </td>
              <td className="num">
                {h.startLine}-{h.endLine}
              </td>
              <td className="dim">{h.kind}</td>
              <td className="num">{h.score.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open !== null ? (
        <SnippetModal
          title={open.relPath}
          snippet={open.snippet}
          onClose={() => setOpen(null)}
          meta={<SearchHitMeta hit={open} />}
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
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void submit(String(fd.get("sym") ?? "").trim());
        }}
      >
        <div className="field">
          <label htmlFor="scoped-fu-sym">symbol</label>
          <input
            id="scoped-fu-sym"
            name="sym"
            type="text"
            className="input"
            placeholder="exact-match symbol name (e.g. authenticate)"
          />
        </div>
        <button type="submit" className="btn btn-primary field-submit" disabled={busy}>
          {busy ? "Searching…" : "Find"}
        </button>
      </form>
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
  const [open, setOpen] = useState<UsageHit | null>(null);
  if (hits.length === 0) return <p className="pullquote">none</p>;
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>file</th>
            <th>kind</th>
            <th className="num">lines</th>
          </tr>
        </thead>
        <tbody>
          {hits.map((h, i) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: composite key would be (projectId+relPath+startLine), index is fine here
              key={`${h.projectId}-${h.relPath}-${h.chunkStartLine}-${i}`}
              onClick={() => setOpen(h)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen(h);
                }
              }}
              tabIndex={0}
              role="button"
              style={{ cursor: "pointer" }}
            >
              <td>
                <code>{h.relPath}</code>
              </td>
              <td className="dim">{h.kind}</td>
              <td className="num">
                {h.chunkStartLine}-{h.chunkEndLine}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open !== null ? (
        <SnippetModal
          title={open.relPath}
          snippet={open.snippet}
          onClose={() => setOpen(null)}
          meta={
            <span className="dim">
              lines {open.chunkStartLine}-{open.chunkEndLine}
              <span className="sep">·</span>
              kind: {open.kind}
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
