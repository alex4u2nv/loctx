import type { FindUsagesPayload, UsageHit } from "@shared/contracts";
import { useState } from "react";
import { DataTable } from "../components/data-table";
import { QueryForm } from "../components/query-form";
import { SnippetModal } from "../components/snippet-modal";
import { api } from "../lib/api";
import { useSnippetSelection } from "../lib/use-snippet-selection";

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

      <QueryForm
        busy={busy}
        submitLabel="Find"
        fields={[
          {
            id: "symbol",
            name: "symbol",
            label: "symbol",
            placeholder: "e.g. authenticate",
            autoFocus: true,
          },
          {
            id: "path",
            name: "path",
            label: "path",
            placeholder: "scope to one project",
            optional: true,
          },
        ]}
        onSubmit={(values) => void submit(values["symbol"] ?? "", values["path"] ?? "")}
      />

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
        <p className="pullquote">No matches for {r.symbol}.</p>
      ) : (
        <>
          <h2>Definitions ({r.defs.length})</h2>
          <UsageTable hits={r.defs} />
          <h2>References ({r.refs.length})</h2>
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
