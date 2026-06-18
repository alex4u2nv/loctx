import type { FindUsagesPayload, UsageHit } from "@shared/contracts";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DataTable } from "../components/data-table";
import { QueryForm } from "../components/query-form";
import { SnippetModal } from "../components/snippet-modal";
import { api } from "../lib/api";
import { useSnippetSelection } from "../lib/use-snippet-selection";

export function FindUsagesPage() {
  const [params, setParams] = useSearchParams();
  const urlSymbol = params.get("symbol") ?? "";
  const urlPath = params.get("path") ?? "";
  const [response, setResponse] = useState<FindUsagesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (symbol: string, path: string): Promise<void> => {
      // Mirror submission into the URL so back/forward and deep-link from
      // /search both work. Skip the URL push when nothing changed.
      const next = new URLSearchParams();
      if (symbol) next.set("symbol", symbol);
      if (path) next.set("path", path);
      if (next.toString() !== params.toString()) setParams(next);
      if (!symbol) {
        setResponse(null);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const r = await api.findUsages({ symbol, ...(path ? { path } : {}) });
        setResponse(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResponse(null);
      } finally {
        setBusy(false);
      }
    },
    [params, setParams],
  );

  // Auto-fire when a deep-link arrives with ?symbol=... (e.g. clicking a
  // symbol on /search). Only on the initial URL value to avoid loops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — fire once per URL change
  useEffect(() => {
    if (urlSymbol) void submit(urlSymbol, urlPath);
  }, [urlSymbol, urlPath]);

  return (
    <section>
      <span className="eyebrow">Cross-reference</span>
      <h1 className="display">Find usages</h1>
      <p className="subtitle">
        Exact-match symbol jump. Returns every definition and call/import/reference of a name
        across the indexed projects.
      </p>

      <div className="card-stack">
        <div className="card">
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
            onSubmit={(values) => void submit(values["symbol"] ?? "", values["path"] ?? "")}
          />
        </div>

        {error !== null ? (
          <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
            {error}
          </p>
        ) : response === null ? null : (
          <div className="card">
            <Results r={response} scopedPath={urlPath} onClearScope={() => void submit(response.symbol, "")} />
          </div>
        )}
      </div>
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
        <p
          key={w}
          className="pullquote"
          style={{ borderLeftColor: "var(--warn)", color: "var(--warn)" }}
        >
          {w}
        </p>
      ))}
      {empty ? (
        scopedPath !== "" ? (
          <p className="pullquote">
            No matches for <code>{r.symbol}</code> in <code>{scopedPath}</code>. The symbol may
            be defined in another project —{" "}
            <button type="button" className="btn-link" onClick={onClearScope}>
              clear the path filter
            </button>{" "}
            to search every indexed project.
          </p>
        ) : (
          <p className="pullquote">
            No matches for <code>{r.symbol}</code> across every indexed project. The symbol may
            not exist, or its file isn't indexed (check <code>.gitignore</code> /
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
