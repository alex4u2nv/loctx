import { useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function ModelsPage() {
  const { data, error, loading, reload } = useFetch(() => api.models(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleUse = async (name: string): Promise<void> => {
    setBusy(name);
    setMessage(null);
    try {
      const r = await api.modelUse(name);
      setMessage(`Switched to ${name}. ${r.message}`);
      reload();
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = async (name: string): Promise<void> => {
    setBusy(name);
    setMessage(null);
    try {
      await api.modelDownload(name);
      setMessage(`Downloaded ${name}.`);
      reload();
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <span className="eyebrow">Embeddings</span>
      <h1 className="display">Models</h1>
      <p className="subtitle">
        Switch the active embedding model or pre-download one for offline use. A model change
        invalidates the existing index — reset + re-index after switching.
      </p>
      {message ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--warn)" }}>
          {message}
        </p>
      ) : null}
      {loading && data === null ? (
        <p className="pullquote">Loading…</p>
      ) : error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : data === null ? null : (
        <table className="data-table">
          <thead>
            <tr>
              <th>model</th>
              <th>state</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {data.available.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td className="dim">
                  {m.current ? "active" : ""}
                  {m.current && m.downloaded ? " · " : ""}
                  {m.downloaded ? "downloaded" : "not downloaded"}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleUse(m.id)}
                    disabled={busy !== null || m.current}
                  >
                    use
                  </button>{" "}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleDownload(m.id)}
                    disabled={busy !== null}
                  >
                    {busy === m.id ? "downloading…" : "download"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
