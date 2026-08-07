import { AdminTabs } from "../components/admin-tabs";
import { AsyncBoundary } from "../components/async-boundary";
import { Banner } from "../components/banner";
import { confirm } from "../components/confirm";
import { DataTable } from "../components/data-table";
import { IconButton } from "../components/icon-button";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";
import { useOpRunner } from "../lib/use-op-runner";

export function ModelsPage() {
  const { data, error, loading, reload } = useFetch(() => api.models(), []);
  // Busy/message runner shared with /admin and /projects (audit WEB-6).
  const ops = useOpRunner(reload);

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
    await ops.run(name, () => api.modelUse(name), {
      success: (r) => `Switched to ${name}. ${r.message}`,
    });
  };

  const handleDownload = async (name: string): Promise<void> => {
    await ops.run(name, () => api.modelDownload(name), {
      success: () => `Downloaded ${name}.`,
    });
  };

  return (
    <section>
      <span className="eyebrow">Embeddings</span>
      <h1 className="display">Models</h1>
      <p className="subtitle">
        Switch the active embedding model or pre-download one for offline use. A model change
        invalidates the existing index — reset + re-index after switching.
      </p>

      <AdminTabs />

      {ops.message ? (
        <Banner tone="warn" soft>
          {ops.message}
        </Banner>
      ) : null}
      <AsyncBoundary state={{ data, error, loading, reload }}>
        {(models) => (
          <div className="card card-flush">
            <DataTable
              rows={models.available}
              rowKey={(m) => m.id}
              columns={[
                { key: "model", header: "model", cell: (m) => m.id },
                // Downloads come straight from Hugging Face; the user accepts
                // this license, not a loctx one — so it must be visible pre-click.
                { key: "license", header: "license", dim: true, cell: (m) => m.license },
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
                      <IconButton
                        label="use"
                        onClick={() => void handleUse(m.id)}
                        disabled={ops.busy !== null || m.current}
                      />{" "}
                      <IconButton
                        label={ops.busy === m.id ? "downloading…" : "download"}
                        onClick={() => void handleDownload(m.id)}
                        disabled={ops.busy !== null}
                      />
                    </>
                  ),
                },
              ]}
            />
          </div>
        )}
      </AsyncBoundary>
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
      <span
        className="warn"
        title="The daemon will fetch this on first embed. Click 'download' to pre-fetch."
      >
        active · pending download
      </span>
    );
  if (downloaded) return <>downloaded</>;
  return <>not downloaded</>;
}
