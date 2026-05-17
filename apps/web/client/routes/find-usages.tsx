import type { FindUsagesPayload, UsageHit } from "@shared/contracts";
import { useState } from "react";
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
  return (
    <table className="data-table usage-table">
      {/* Fixed column widths so the Definitions and References tables
          line up — two independent <table>s would otherwise auto-size
          their columns differently per the content of each. */}
      <colgroup>
        <col className="col-project" />
        <col className="col-file" />
        <col className="col-kind" />
        <col className="col-lines" />
      </colgroup>
      <thead>
        <tr>
          <th>project</th>
          <th>file</th>
          <th>kind</th>
          <th>lines</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: composite key would be (projectId+relPath+startLine), index is fine here
          <tr key={`${h.projectId}-${h.relPath}-${h.chunkStartLine}-${i}`}>
            <td className="dim" title={h.projectId}>
              {h.projectName}
            </td>
            <td>{h.relPath}</td>
            <td className="dim">{h.kind}</td>
            <td className="num">
              {h.chunkStartLine}-{h.chunkEndLine}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
