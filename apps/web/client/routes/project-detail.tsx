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
  ProjectDetailPayload,
  QualityReportPayload,
  SearchHit,
  SearchPayload,
  UsageHit,
} from "@shared/contracts";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AsyncError, AsyncLoading, AsyncNoData } from "../components/async-boundary";
import { Banner } from "../components/banner";
import { BarChart, type BarRow } from "../components/bar-chart";
import { type Column, DataTable } from "../components/data-table";
import { LiteralResults } from "../components/literal-results";
import { useLiveRefreshEvent } from "../components/live-refresh";
import { QueryForm } from "../components/query-form";
import { SectionNav } from "../components/section-nav";
import { SnippetModal } from "../components/snippet-modal";
import { SurfaceCard } from "../components/surface-card";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useFetch } from "../lib/use-fetch";
import { useSnippetSelection } from "../lib/use-snippet-selection";
import { useQuery } from "../lib/use-url-query";

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

  if (fetched.loading && fetched.data === null) return <AsyncLoading />;
  if (fetched.error !== null)
    return (
      <AsyncError error={fetched.error}>
        <br />
        <Link to="/projects">← back to projects</Link>
      </AsyncError>
    );
  if (fetched.data === null) return <AsyncNoData />;

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
        id="pd-overview"
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
            {project.rebuilding !== null && project.rebuilding.status === "running" ? (
              <span className="warn">
                indexing… {project.rebuilding.indexed}
                {project.rebuilding.totalFiles !== null ? `/${project.rebuilding.totalFiles}` : ""}{" "}
                files
              </span>
            ) : (
              <span className="dim">indexed {relativeTime(project.lastIndexed)}</span>
            )}
            <span className="sep">·</span>
            {project.reconciling !== null ? (
              <span className="warn">
                reconciling…{" "}
                {project.reconciling.indexed !== null && project.reconciling.total !== null
                  ? `${project.reconciling.indexed.toLocaleString()} / ${project.reconciling.total.toLocaleString()} files`
                  : "walking"}
              </span>
            ) : (
              <span className="dim">reconciled {relativeTime(project.lastReconciled)}</span>
            )}
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

      <div id="pd-query">
        <ScopedSearchPanel projectRoot={project.root} />
      </div>

      <QualitySection projectId={project.id} />

      <h2 id="pd-files">Recently indexed</h2>
      <FilesTable rows={stats.recentFiles} kind="recent" />

      {stats.failingFiles.length > 0 ? (
        <>
          <h2>Files with errors ({stats.failingFiles.length})</h2>
          <FailingTable rows={stats.failingFiles} />
        </>
      ) : null}

      <SectionNav
        sections={[
          { id: "pd-overview", label: "Overview" },
          { id: "pd-query", label: "Query" },
          { id: "pd-files", label: "Files" },
        ]}
      />
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

function FilesTable({ rows, kind }: { rows: ReadonlyArray<FileRow>; kind: "top" | "recent" }) {
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

// ---- scoped search / find-usages / find-literal panel ------------------

type Tab = "search" | "find-usages" | "find-literal";

/**
 * Resolve a free-text subtree input against the project root.
 * Empty subtree → project root (full project scope).
 * Subtree like "apps/cli" → projectRoot/apps/cli (subtree scope).
 * Absolute path → passed through as-is (advanced use).
 */
function resolveSubtree(projectRoot: string, subtree: string): string {
  const s = subtree.trim().replace(/^\/+|\/+$/g, "");
  if (s === "") return projectRoot;
  if (s.startsWith("/")) return s;
  return `${projectRoot}/${s}`;
}

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
        <TabButton active={tab === "find-literal"} onClick={() => setTab("find-literal")}>
          find-literal
        </TabButton>
      </div>
      {/* Rendered once, outside the tab switch: both the search and
          find-literal panels reference this datalist by id, and only one
          panel exists in the DOM at a time — a panel-local datalist
          silently breaks the other tab's suggestions (WEB-5). */}
      <datalist id="scoped-subtree-suggestions">
        {["src", "apps", "packages", "lib", "tests", "docs"].map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {tab === "search" ? (
        <ScopedSearch projectRoot={projectRoot} />
      ) : tab === "find-usages" ? (
        <ScopedFindUsages projectRoot={projectRoot} />
      ) : (
        <ScopedFindLiteral projectRoot={projectRoot} />
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
  // Shared query machine (audit WEB-4) — no URL mirroring here: three
  // panels share one page, so their queries stay off the search string.
  const q = useQuery((args: { query: string; subtree: string; coverage: boolean }) =>
    api.search({
      query: args.query,
      path: resolveSubtree(projectRoot, args.subtree),
      limit: 25,
      ...(args.coverage ? { coverage: true } : {}),
    }),
  );
  return (
    <>
      <QueryForm
        busy={q.busy}
        submitLabel="Search"
        busyLabel="Searching…"
        fields={[
          {
            id: "scoped-search-q",
            name: "q",
            label: "query",
            placeholder: "semantic + lexical search across this project",
          },
          {
            id: "scoped-search-subtree",
            name: "subtree",
            label: "subtree",
            optional: true,
            datalist: "scoped-subtree-suggestions",
            placeholder: "e.g. apps/cli or src",
            width: "16rem",
          },
          {
            id: "scoped-search-coverage",
            name: "coverage",
            label: "coverage",
            type: "checkbox",
            title:
              "Expand top hits with their callers + importers via the symbol cross-reference graph. Useful for refactor planning.",
          },
        ]}
        onSubmit={(values) => {
          const query = values["q"] ?? "";
          if (query === "") return;
          q.submit({
            query,
            subtree: values["subtree"] ?? "",
            coverage: values["coverage"] === "on",
          });
        }}
      />
      {q.error !== null ? <AsyncError error={q.error} /> : null}
      {q.data !== null ? <SearchResults response={q.data} /> : null}
    </>
  );
}

function SearchResults({ response }: { response: SearchPayload }) {
  const { selected, open, close } = useSnippetSelection<SearchHit>();
  const hits = response.results;
  const warnings = response.warnings ?? [];
  return (
    <>
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}
      {hits.length === 0 ? (
        <p className="pullquote">
          No matches in this project. Try a broader query or use the global{" "}
          <Link to="/search">search page</Link> to scan every indexed project.
        </p>
      ) : (
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
      )}
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
          <span className="dim">
            symbols:{" "}
            {hit.symbols.map((s, i) => (
              <span key={s}>
                {i > 0 ? ", " : ""}
                {hit.kind.startsWith("section") ? (
                  // Markdown section "symbols" are the heading path, not code
                  // symbols in the cross-ref graph — search, not find-usages.
                  // Key on `kind` (always set) not `language` (lexical hits
                  // can leave it empty).
                  <Link
                    className="btn-link"
                    to={`/search?q=${encodeURIComponent(s)}`}
                    title={`search for "${s}"`}
                  >
                    {s}
                  </Link>
                ) : (
                  <Link
                    className="btn-link"
                    to={`/find-usages?symbol=${encodeURIComponent(s)}`}
                    title={`find usages of ${s}`}
                  >
                    {s}
                  </Link>
                )}
              </span>
            ))}
          </span>
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
  // find_usages is project-scoped by design — subtree filter wouldn't
  // change recall here, so this stays a single field.
  const q = useQuery((symbol: string) => api.findUsages({ symbol, path: projectRoot }));
  return (
    <>
      <QueryForm
        busy={q.busy}
        submitLabel="Find"
        fields={[
          {
            id: "scoped-fu-sym",
            name: "sym",
            label: "symbol",
            placeholder: "exact-match symbol name (e.g. authenticate)",
          },
        ]}
        onSubmit={(values) => {
          const symbol = values["sym"] ?? "";
          if (symbol !== "") q.submit(symbol);
        }}
      />
      {q.error !== null ? <AsyncError error={q.error} /> : null}
      {q.data !== null ? (
        <UsageResults defs={q.data.defs} refs={q.data.refs} symbol={q.data.symbol} />
      ) : null}
    </>
  );
}

function ScopedFindLiteral({ projectRoot }: { projectRoot: string }) {
  const q = useQuery((args: { pattern: string; subtree: string }) =>
    api.findLiteral({
      pattern: args.pattern,
      path: resolveSubtree(projectRoot, args.subtree),
    }),
  );
  return (
    <>
      <QueryForm
        busy={q.busy}
        submitLabel="Find"
        busyLabel="Scanning…"
        fields={[
          {
            id: "scoped-fl-pattern",
            name: "pattern",
            label: "pattern",
            placeholder: "literal substring — paths, urls, identifiers",
          },
          {
            id: "scoped-fl-subtree",
            name: "subtree",
            label: "subtree",
            optional: true,
            datalist: "scoped-subtree-suggestions",
            placeholder: "e.g. apps/cli",
            width: "16rem",
          },
        ]}
        onSubmit={(values) => {
          const pattern = values["pattern"] ?? "";
          if (pattern === "") return;
          q.submit({ pattern, subtree: values["subtree"] ?? "" });
        }}
      />
      {q.error !== null ? <AsyncError error={q.error} /> : null}
      {q.data !== null ? (
        <LiteralResults response={q.data} emptyWhere="in indexed chunks for this project" />
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
  if (defs.length === 0 && refs.length === 0) {
    // Scoped panel: we're already inside one project, so the helpful
    // next step is the global /find-usages page (which searches every
    // indexed project). Mirrors the broaden-to-global treatment the
    // scoped-search panel uses.
    return (
      <p className="pullquote">
        No matches for <code>{symbol}</code> in this project. Open{" "}
        <Link to={`/find-usages?symbol=${encodeURIComponent(symbol)}`}>global find-usages</Link> to
        search every indexed project.
      </p>
    );
  }
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

/**
 * Read-only quality report (#525): stored quality findings merged with
 * the query-time cross-file rules, files ranked by severity weight.
 * Provisioning lives on the Analyzers tab; this only reads.
 */
function QualitySection({ projectId }: { projectId: string }) {
  const [rule, setRule] = useState("");
  const [limit, setLimit] = useState(20);
  const fetched = useFetch(
    () => api.projectQuality(projectId, limit, rule),
    [projectId, limit, rule],
  );
  const data = fetched.data;
  if (fetched.loading && data === null) return null;
  if (fetched.error !== null || data === null) return null;
  const hasFindings = data.files.length > 0;
  return (
    <>
      <h2 id="pd-quality">Quality</h2>
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          flexWrap: "wrap",
          alignItems: "stretch",
          marginBottom: "var(--space-3)",
        }}
      >
        {data.rules.map((r) => (
          <RuleTile
            key={r.ruleId}
            rule={r}
            active={rule === r.ruleId}
            onToggle={() => setRule(rule === r.ruleId ? "" : r.ruleId)}
          />
        ))}
        {data.rules.length > 0 ? (
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            style={{ alignSelf: "center", marginLeft: "auto" }}
          >
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                top {n} files
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {data.disabled !== null ? (
        <Banner tone="warn" soft>
          {data.disabled} Configure on the Analyzers tab.
        </Banner>
      ) : null}
      {data.notes.map((n) => (
        <p key={n} className="dim" style={{ fontSize: "0.85rem" }}>
          {n}
        </p>
      ))}
      {hasFindings ? (
        <DataTable columns={qualityColumns} rows={[...data.files]} rowKey={(r) => r.fileId} />
      ) : (
        <p className="dim">
          {data.disabled !== null
            ? "No query-time findings."
            : "No quality findings — nothing over the configured thresholds."}
        </p>
      )}
    </>
  );
}

/**
 * One rule as a clickable mini stat tile: finding count, file spread,
 * severity-tinted. Click filters the table to that rule (server-side,
 * so "top N files" is exact for the rule); click again to clear. The
 * tile row itself is built from the full-report rollup, so counts
 * don't shift while a filter is active.
 */
function RuleTile({
  rule,
  active,
  onToggle,
}: {
  rule: QualityReportPayload["rules"][number];
  active: boolean;
  onToggle: () => void;
}) {
  const sevClass =
    rule.worstSeverity === "error" ? "err" : rule.worstSeverity === "warning" ? "warn" : "dim";
  return (
    <button
      type="button"
      className="card"
      onClick={onToggle}
      aria-pressed={active}
      style={{
        cursor: "pointer",
        padding: "0.5rem 0.85rem",
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        gap: "0.1rem",
        margin: 0,
        borderColor: active ? "var(--accent)" : undefined,
        boxShadow: active ? "inset 0 0 0 1px var(--accent)" : undefined,
      }}
      title={`${rule.ruleId}: ${rule.count} findings in ${rule.files} files — click to ${active ? "clear the filter" : "see the top files"}`}
    >
      <span className="dim" style={{ fontSize: "0.72rem", letterSpacing: "0.02em" }}>
        {rule.ruleId.replace("quality/", "")}
      </span>
      <span>
        <strong className={sevClass} style={{ fontSize: "1.05rem" }}>
          {rule.count.toLocaleString()}
        </strong>{" "}
        <span className="dim" style={{ fontSize: "0.78rem" }}>
          in {rule.files.toLocaleString()} {rule.files === 1 ? "file" : "files"}
        </span>
      </span>
    </button>
  );
}

type QualityRow = QualityReportPayload["files"][number];

const qualityColumns: ReadonlyArray<Column<QualityRow>> = [
  { key: "relPath", header: "file", cell: (r) => <code>{r.relPath}</code> },
  { key: "weight", header: "weight", numeric: true, cell: (r) => r.weight },
  {
    key: "findings",
    header: "findings",
    cell: (r) => (
      <span>
        {r.findings.map((f) => (
          <span
            key={`${f.ruleId}:${f.lineFrom}:${f.message}`}
            className={f.severity === "error" ? "err" : f.severity === "warning" ? "warn" : "dim"}
            style={{ marginRight: "0.5rem", whiteSpace: "nowrap" }}
            title={f.message}
          >
            {f.ruleId.replace("quality/", "")}
            {f.lineFrom > 1 ? `:${f.lineFrom}` : ""}
          </span>
        ))}
      </span>
    ),
  },
];
