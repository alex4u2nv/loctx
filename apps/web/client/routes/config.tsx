import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function ConfigPage() {
  const { data, error, loading } = useFetch(() => api.config(), []);

  return (
    <section>
      <span className="eyebrow">Configuration</span>
      <h1 className="display">Effective config</h1>
      <p className="subtitle">
        Merged view of defaults, global YAML, and project overrides — what the daemon actually
        loaded at boot.
      </p>
      {loading && data === null ? (
        <p className="pullquote">Loading…</p>
      ) : error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : data === null ? (
        <p className="pullquote">No data.</p>
      ) : (
        <>
          <p className="summary">
            global: <code>{data.globalSource ?? "(default)"}</code>
            <span className="sep">·</span>project: <code>{data.projectSource ?? "(none)"}</code>
          </p>
          <pre className="snippet">{JSON.stringify(data.raw, null, 2)}</pre>
        </>
      )}
    </section>
  );
}
