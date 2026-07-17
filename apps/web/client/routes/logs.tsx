import type { McpLogEntry } from "@shared/contracts";
import { useEffect, useState } from "react";
import { AdminTabs } from "../components/admin-tabs";
import { AsyncError, AsyncLoading } from "../components/async-boundary";
import { confirm } from "../components/confirm";
import { DataTable } from "../components/data-table";
import { Icon } from "../components/icon";
import { SnippetModal } from "../components/snippet-modal";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";
import { useSnippetSelection } from "../lib/use-snippet-selection";

// Agents call MCP tools sporadically, and a request can arrive from a
// separate stdio process that doesn't share this daemon's SSE bus — only
// the shared state DB sees every transport. So the page polls rather
// than listening for events: a cheap GET on an interval catches them all.
const POLL_INTERVAL_MS = 3_000;

/**
 * MCP request log. Shows every `tools/call` an agent made — request
 * arguments and the response the daemon returned — newest first. The
 * table is bounded by `mcp.log_max_rows` (Config → MCP); oldest rows are
 * trimmed past that count. The point is quality tuning: watch what
 * agents actually ask for and how the tools answer.
 */
export function LogsPage() {
  const { data, error, loading, reload } = useFetch(() => api.logs(), []);
  const { selected, open, close } = useSnippetSelection<McpLogEntry>();
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Poll on an interval while auto-refresh is on. Skipped when the tab is
  // hidden so background tabs don't hammer the daemon. `reload` is stable
  // (useCallback in useFetch), so the effect only re-subscribes when the
  // toggle flips.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (!document.hidden) reload();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, reload]);

  const onClear = async (): Promise<void> => {
    if (!(await confirm({ message: "Clear the entire MCP request log?", danger: true }))) return;
    await api.logsClear();
    reload();
  };

  // Only block the controls on the very first load; polling refetches
  // keep `data` populated, so the button must not flicker disabled.
  const initialLoad = loading && data === null;

  return (
    <section>
      <span className="eyebrow">Observability</span>
      <h1 className="display">Logs</h1>
      <p className="subtitle">
        MCP requests, questions and answers from connected agents. Click a row to inspect the full
        request arguments and response.
      </p>

      <AdminTabs />

      {error !== null ? <AsyncError error={error} /> : null}

      <div className="card-stack">
      <div className="card">
      <p style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
        <button type="button" className="btn btn-primary" onClick={reload} disabled={initialLoad}>
          <Icon name="refresh" /> {initialLoad ? "Loading…" : "Refresh"}
        </button>
        <label
          className="dim"
          style={{ display: "inline-flex", gap: "var(--space-1)", alignItems: "center" }}
        >
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          auto-refresh
        </label>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void onClear()}
          disabled={initialLoad || (data?.total ?? 0) === 0}
        >
          Clear log
        </button>
        {data !== null ? (
          <span className="dim">
            {data.maxRows === 0
              ? "logging disabled (set mcp.log_max_rows > 0 in Config)"
              : `showing ${data.entries.length} of ${data.maxRows} retained`}
          </span>
        ) : null}
      </p>
      </div>

      <div className="card card-flush">
      {data === null && error === null ? (
        <AsyncLoading />
      ) : data === null ? null : (
        <DataTable<McpLogEntry>
          className="logs-table"
          rows={data.entries}
          rowKey={(r) => String(r.id)}
          onRowClick={open}
          emptyMessage={
            data.maxRows === 0
              ? "Request logging is disabled."
              : "No MCP requests logged yet."
          }
          columns={[
            {
              key: "time",
              header: "time",
              dim: true,
              cell: (r) => new Date(r.requestedAt).toLocaleString(),
            },
            { key: "tool", header: "tool", cell: (r) => <code>{r.tool}</code> },
            {
              key: "status",
              header: "status",
              cell: (r) =>
                r.ok ? (
                  <span>
                    <Icon name="ok" /> ok
                  </span>
                ) : (
                  <span className="err">
                    <Icon name="err" /> error
                  </span>
                ),
            },
            {
              key: "elapsed",
              header: "ms",
              numeric: true,
              cell: (r) => r.elapsedMs,
            },
            {
              key: "request",
              header: "request",
              dim: true,
              cell: (r) => summarizeArguments(r.argumentsJson),
            },
          ]}
        />
      )}
      </div>
      </div>

      {selected !== null ? (
        <SnippetModal
          title={selected.tool}
          language="json"
          snippet={detailBody(selected)}
          onClose={close}
          meta={
            <span className="dim">
              {new Date(selected.requestedAt).toLocaleString()}
              <span className="sep">·</span>
              {selected.ok ? "ok" : "error"}
              <span className="sep">·</span>
              {selected.elapsedMs} ms
            </span>
          }
        />
      ) : null}
    </section>
  );
}

/** One-line preview of the request arguments for the table cell. */
function summarizeArguments(argumentsJson: string): string {
  try {
    const args = JSON.parse(argumentsJson) as Record<string, unknown>;
    // Surface the field that usually carries the agent's question.
    for (const key of ["query", "symbol", "pattern"]) {
      const v = args[key];
      if (typeof v === "string" && v !== "") return v;
    }
    const compact = JSON.stringify(args);
    return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
  } catch {
    return argumentsJson;
  }
}

/**
 * Full request + response body for the detail modal. Arguments are
 * pretty-printed; the response is already indented JSON (or the error
 * message when the call failed).
 */
function detailBody(entry: McpLogEntry): string {
  const args = prettyJson(entry.argumentsJson);
  const answer = entry.ok
    ? (entry.responseJson ?? "<no response>")
    : (entry.error ?? "<unknown error>");
  return `// request\n${args}\n\n// ${entry.ok ? "response" : "error"}\n${answer}`;
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
