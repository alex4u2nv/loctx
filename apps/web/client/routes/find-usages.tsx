import type { FindUsagesPayload, UsageHit } from "@shared/contracts";
import { useState } from "react";
import { DataTable } from "../components/data-table";
import { api } from "../lib/api";

export function FindUsagesPage() {
  const [response, setResponse] = useState<FindUsagesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (symbol: string, path: string): Promise<void> => {
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
  };

  return (
    <section>
      <span className="eyebrow">Cross-reference</span>
      <h1 className="display">Find usages</h1>
      <p className="subtitle">
        Exact-match symbol jump. Returns every definition and call/import/reference of a name
        across the indexed projects.
      </p>

      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void submit(
            String(fd.get("symbol") ?? "").trim(),
            String(fd.get("path") ?? "").trim(),
          );
        }}
      >
        <div className="field">
          <label htmlFor="symbol">symbol</label>
          <input id="symbol" name="symbol" type="text" className="input" placeholder="e.g. authenticate" />
        </div>
        <div className="field">
          <label htmlFor="path">path (optional)</label>
          <input id="path" name="path" type="text" className="input" placeholder="scope to one project" />
        </div>
        <button type="submit" className="btn btn-primary field-submit" disabled={busy}>
          {busy ? "Searching…" : "Find"}
        </button>
      </form>

      {error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : response === null ? null : (
        <Results r={response} />
      )}
    </section>
  );
}

function Results({ r }: { r: FindUsagesPayload }) {
  if (r.defs.length === 0 && r.refs.length === 0)
    return <p className="pullquote">No matches for {r.symbol}.</p>;
  return (
    <>
      <h2>Definitions ({r.defs.length})</h2>
      <UsageTable hits={r.defs} />
      <h2>References ({r.refs.length})</h2>
      <UsageTable hits={r.refs} />
    </>
  );
}

function UsageTable({ hits }: { hits: ReadonlyArray<UsageHit> }) {
  if (hits.length === 0) return <p className="pullquote">none</p>;
  // Fixed column widths via .usage-table .col-* in styles.css so the
  // Definitions and References tables line up across the page — two
  // independent <table>s would otherwise auto-size per their content.
  return (
    <DataTable
      className="usage-table"
      rows={hits}
      rowKey={(h, i) => `${h.projectId}-${h.relPath}-${h.chunkStartLine}-${i}`}
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
  );
}
