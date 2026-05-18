import { useEffect, useRef, useState } from "react";
import { DataTable } from "../components/data-table";
import { Icon } from "../components/icon";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function DoctorPage() {
  const { data, error, loading, reload } = useFetch(() => api.doctor(), []);
  // Brief "✓ Done" confirmation after a user-triggered reload. The
  // checks finish fast enough that without this the button just
  // blinks "Re-running…" and snaps back; users can't tell whether
  // their click landed. We only flash the confirmation when the user
  // pressed the button (not on the initial mount fetch).
  const [justCompleted, setJustCompleted] = useState(false);
  const userTriggered = useRef(false);
  const wasLoading = useRef(loading);
  useEffect(() => {
    if (
      wasLoading.current &&
      !loading &&
      error === null &&
      data !== null &&
      userTriggered.current
    ) {
      userTriggered.current = false;
      setJustCompleted(true);
      const t = setTimeout(() => setJustCompleted(false), 1600);
      return () => clearTimeout(t);
    }
    wasLoading.current = loading;
    return undefined;
  }, [loading, error, data]);

  const onRerun = (): void => {
    userTriggered.current = true;
    setJustCompleted(false);
    reload();
  };

  return (
    <section>
      <span className="eyebrow">Health</span>
      <h1 className="display">Doctor</h1>
      <p className="subtitle">
        Configuration, storage, daemon, schema, discovery and analyzer health.
      </p>
      <p>
        <button
          type="button"
          className={`btn ${justCompleted ? "btn-success" : "btn-primary"}`}
          onClick={onRerun}
          disabled={loading}
        >
          {loading ? (
            <>
              <Icon name="refresh" /> Re-running…
            </>
          ) : justCompleted ? (
            <>
              <Icon name="ok" /> Done
            </>
          ) : (
            <>
              <Icon name="refresh" /> Re-run checks
            </>
          )}
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
          <DataTable
            rows={data.checks}
            rowKey={(c) => c.name}
            columns={[
              { key: "check", header: "check", cell: (c) => c.name },
              {
                key: "status",
                header: "status",
                cell: (c) => <DoctorStatusCell status={c.status} />,
              },
              { key: "detail", header: "detail", dim: true, cell: (c) => c.detail },
            ]}
          />
        </>
      )}
    </section>
  );
}

function DoctorStatusCell({ status }: { status: "ok" | "warn" | "error" }) {
  if (status === "error") {
    return (
      <span className="err">
        <Icon name="err" /> error
      </span>
    );
  }
  if (status === "warn") {
    return (
      <span className="warn">
        <Icon name="warn" /> warn
      </span>
    );
  }
  return (
    <span>
      <Icon name="ok" /> ok
    </span>
  );
}
