import type { FindUsagesPayload, UsageHit } from "@shared/contracts";
import { AsyncError } from "../components/async-boundary";
import { Banner } from "../components/banner";
import { DataTable } from "../components/data-table";
import { QueryForm } from "../components/query-form";
import { SearchTabs } from "../components/search-tabs";
import { SectionNav } from "../components/section-nav";
import { SnippetModal } from "../components/snippet-modal";
import { api } from "../lib/api";
import { type FindUsagesQuery, findUsagesCodec } from "../lib/query-codecs";
import { useSnippetSelection } from "../lib/use-snippet-selection";
import { useUrlQuery } from "../lib/use-url-query";

export function FindUsagesPage() {
  // URL-driven query state machine (audit WEB-2): submit mirrors into
  // the URL so back/forward and deep-links from /search both work;
  // arriving URLs auto-fire exactly once.
  const { params, data, error, busy, submit } = useUrlQuery(
    findUsagesCodec,
    (req: FindUsagesQuery) =>
      api.findUsages({ symbol: req.symbol, ...(req.path ? { path: req.path } : {}) }),
  );
  const urlSymbol = params.get("symbol") ?? "";
  const urlPath = params.get("path") ?? "";
  const response = data;

  return (
    <section>
      <span className="eyebrow">Cross-reference</span>
      <h1 className="display">Find usages</h1>
      <p className="subtitle">
        Exact-match symbol jump. Returns every definition and call/import/reference of a name across
        the indexed projects.
      </p>

      <SearchTabs />

      <div className="card-stack">
        <div className="card" id="fu-query">
          <QueryForm
            // Re-mount the form when URL params change so the inputs pick up
            // fresh defaultValues. Cheap; the form is uncontrolled.
            key={`${urlSymbol}|${urlPath}`}
            busy={busy}
            submitLabel="Find"
            fields={[
              {
                id: "symbol",
                name: "symbol",
                label: "symbol",
                placeholder: "e.g. authenticate",
                autoFocus: true,
                defaultValue: urlSymbol,
              },
              {
                id: "path",
                name: "path",
                label: "path",
                placeholder: "scope to one project",
                optional: true,
                defaultValue: urlPath,
              },
            ]}
            onSubmit={(values) =>
              submit({ symbol: values["symbol"] ?? "", path: values["path"] ?? "" })
            }
          />
        </div>

        {error !== null ? (
          <AsyncError error={error} />
        ) : response === null ? null : (
          <div className="card" id="fu-results">
            <Results
              r={response}
              scopedPath={urlPath}
              onClearScope={() => submit({ symbol: response.symbol, path: "" })}
            />
          </div>
        )}
      </div>
      {response !== null ? (
        <SectionNav
          sections={[
            { id: "fu-query", label: "Query" },
            { id: "fu-results", label: "Results" },
          ]}
        />
      ) : null}
    </section>
  );
}

function Results({
  r,
  scopedPath,
  onClearScope,
}: {
  r: FindUsagesPayload;
  scopedPath: string;
  onClearScope: () => void;
}) {
  const warnings = r.warnings ?? [];
  const empty = r.defs.length === 0 && r.refs.length === 0;
  return (
    <>
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}
      {empty ? (
        scopedPath !== "" ? (
          <p className="pullquote">
            No matches for <code>{r.symbol}</code> in <code>{scopedPath}</code>. The symbol may be
            defined in another project —{" "}
            <button type="button" className="btn-link" onClick={onClearScope}>
              clear the path filter
            </button>{" "}
            to search every indexed project.
          </p>
        ) : (
          <p className="pullquote">
            No matches for <code>{r.symbol}</code> across every indexed project. The symbol may not
            exist, or its file isn't indexed (check <code>.gitignore</code> /
            <code>.loctxignore</code> / language filter).
          </p>
        )
      ) : (
        <>
          <p className="card-section-title">Definitions ({r.defs.length})</p>
          <UsageTable hits={r.defs} />
          <p className="card-section-title">References ({r.refs.length})</p>
          <UsageTable hits={r.refs} />
        </>
      )}
    </>
  );
}

function UsageTable({ hits }: { hits: ReadonlyArray<UsageHit> }) {
  const { selected, open, close } = useSnippetSelection<UsageHit>();
  if (hits.length === 0) return <p className="pullquote">none</p>;
  // Fixed column widths via .usage-table .col-* in styles.css so the
  // Definitions and References tables line up across the page — two
  // independent <table>s would otherwise auto-size per their content.
  return (
    <>
      <DataTable
        className="usage-table"
        rows={hits}
        rowKey={(h, i) => `${h.projectId}-${h.relPath}-${h.chunkStartLine}-${i}`}
        onRowClick={open}
        columns={[
          {
            key: "project",
            header: "project",
            dim: true,
            colClassName: "col-project",
            cell: (h) => <span title={h.projectId}>{h.projectName}</span>,
          },
          {
            key: "file",
            header: "file",
            colClassName: "col-file",
            cell: (h) => h.relPath,
          },
          {
            key: "kind",
            header: "kind",
            dim: true,
            colClassName: "col-kind",
            cell: (h) => h.kind,
          },
          {
            key: "lines",
            header: "lines",
            numeric: true,
            colClassName: "col-lines",
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
              <span className="sep">·</span>
              project: {selected.projectName}
            </span>
          }
        />
      ) : null}
    </>
  );
}
