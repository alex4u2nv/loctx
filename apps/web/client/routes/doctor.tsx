import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function DoctorPage() {
  const { data, error, loading, reload } = useFetch(() => api.doctor(), []);

  return (
    <section>
      <span className="eyebrow">Health</span>
      <h1 className="display">Doctor</h1>
      <p className="subtitle">
        Configuration, storage, daemon, schema, discovery and analyzer health.
      </p>
      <p>
        <button type="button" className="btn btn-primary" onClick={reload} disabled={loading}>
          {loading ? "Re-running…" : "Re-run checks"}
        </button>
      </p>
      {error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : data === null ? (
        <p className="pullquote">Loading…</p>
      ) : (
        <>
          <p className="summary">
            summary: <strong>{data.summary}</strong>
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>check</th>
                <th>status</th>
                <th>detail</th>
              </tr>
            </thead>
            <tbody>
              {data.checks.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className={c.ok ? "" : "warn"}>{c.ok ? "ok" : "warn/err"}</td>
                  <td className="dim">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
