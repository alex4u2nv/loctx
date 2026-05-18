import { useState } from "react";
import { confirm } from "../components/confirm";
import { DataTable } from "../components/data-table";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function ModelsPage() {
  const { data, error, loading, reload } = useFetch(() => api.models(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleUse = async (name: string): Promise<void> => {
    // Switching embedding models invalidates the existing index. The
    // server writes the new model name to config but doesn't touch
    // stored vectors — on next daemon start, LanceDB throws
    // CollectionIdentityMismatch and the user has to `loctx reset
    // index --force` then re-embed every chunk in every project
    // (potentially hours of work). Same destructive-action posture
    // as /admin's reset/restart/stop buttons — gate it behind a
    // confirm dialog.
    const ok = await confirm({
      title: `Switch embedding model to ${name}?`,
      message:
        "The existing index was built for the previous model and will mismatch the new one. After the switch you'll need to `loctx reset index --force` (or click Reset on /admin) and re-index every project. Re-embedding can take minutes to hours depending on workspace size.",
      confirmLabel: "Switch model",
      danger: true,
    });
    if (!ok) return;
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
        <DataTable
          rows={data.available}
          rowKey={(m) => m.id}
          columns={[
            { key: "model", header: "model", cell: (m) => m.id },
            {
              key: "state",
              header: "state",
              dim: true,
              cell: (m) => <ModelState current={m.current} downloaded={m.downloaded} />,
            },
            {
              key: "actions",
              header: "actions",
              cell: (m) => (
                <>
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
                </>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}

/**
 * `current` and `downloaded` come from independent sources (config vs.
 * HF cache existsSync), so all four combinations are reachable. The
 * surprising one is `current=true, downloaded=false` — the user picked
 * the model but the daemon hasn't pulled the weights yet. The daemon
 * will fetch lazily on first embed, but until then it literally can't
 * index. Surface that as a distinct, mildly-warning state rather than
 * shoving "active" and "not downloaded" together as if they're
 * compatible.
 */
function ModelState({ current, downloaded }: { current: boolean; downloaded: boolean }) {
  if (current && downloaded) return <>active · downloaded</>;
  if (current && !downloaded)
    return (
      <span className="warn" title="The daemon will fetch this on first embed. Click 'download' to pre-fetch.">
        active · pending download
      </span>
    );
  if (downloaded) return <>downloaded</>;
  return <>not downloaded</>;
}
