/**
 * Dashboard — Phoenix-influenced operational overview.
 *
 * The home page used to be a `Status` data dump (key/value pairs +
 * project table). It's now a layout with three primary slots:
 *
 *   - INDEX FLOW (hero, left): source → output visualization. The
 *     source is the indexed-chunk total; outputs are the discovered
 *     projects, each rendered as a pill that glows when its watcher
 *     is healthy. Hero foot shows uptime + average load.
 *   - DAEMON (top right): condensed running/stopped status, version,
 *     and the MCP endpoint snippet.
 *   - COVERAGE (bottom right): half-circle gauge of (indexed files /
 *     discovered files).
 *
 * Bottom row: DETAILS metric tiles, watcher ACTIVITY (live SSE),
 * MCP client snippets.
 */

import type { StatusPayload } from "@shared/contracts";
import { useCallback, useEffect, useState } from "react";
import { FlowChart, type FlowProject } from "../components/flow-chart";
import { useLiveRefreshEvent } from "../components/live-refresh";
import { SectionNav } from "../components/section-nav";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

interface WatcherEvent {
  readonly at: number;
  readonly projectName: string;
  readonly relPath: string;
  readonly kind: "add" | "change" | "unlink";
}

export function StatusPage() {
  const statusReq = useFetch(() => api.status(), []);
  const projectsReq = useFetch(() => api.projects(), []);
  const onRefresh = useCallback(() => {
    statusReq.reload();
    projectsReq.reload();
  }, [statusReq.reload, projectsReq.reload]);
  useLiveRefreshEvent(onRefresh);
  const events = useWatcherEvents(8);

  if (statusReq.loading && statusReq.data === null) {
    return <p className="pullquote">Loading…</p>;
  }
  if (statusReq.error !== null) {
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
        {statusReq.error}
      </p>
    );
  }
  if (statusReq.data === null) return <p className="pullquote">No data.</p>;

  const status = statusReq.data;
  const projects = projectsReq.data?.active ?? [];
  const inactiveCount = projectsReq.data?.inactive.length ?? 0;
  const totals = projects.reduce(
    (acc, row) => ({
      files: acc.files + row.files,
      chunks: acc.chunks + row.chunks,
      errors: acc.errors + row.errors,
    }),
    { files: 0, chunks: 0, errors: 0 },
  );

  const daemon = status.daemon;
  const baseUrl =
    daemon.running && daemon.port !== null
      ? `http://${daemon.hostname ?? "127.0.0.1"}:${daemon.port}`
      : "http://127.0.0.1:3022";

  // Coverage: discovered projects that have *any* indexed content. We
  // base the gauge on chunks rather than live watcher state so a daemon
  // started with --no-watch still shows useful coverage (the watcher is
  // a freshness signal, not a "did we index this once" signal).
  const indexedProjects = projects.filter((p) => p.chunks > 0).length;
  // Discovered = active + inactive (anything we know about under the
  // workspace_roots, regardless of whether it's currently indexing).
  const discoveredProjects = projects.length + inactiveCount;
  const coveragePct =
    projects.length === 0 ? 0 : Math.round((indexedProjects / projects.length) * 100);

  const flowProjects: FlowProject[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    chunks: p.chunks,
    watcher: p.watcher,
  }));

  return (
    <section className="dashboard">
      <IndexFlowHero
        totals={totals}
        flowProjects={flowProjects}
        indexedProjects={indexedProjects}
        discoveredProjects={discoveredProjects}
        daemonRunning={daemon.running}
      />
      <DaemonCard status={status} baseUrl={baseUrl} />
      <CoverageGauge percent={coveragePct} healthy={indexedProjects} total={projects.length} />
      <div className="tiles">
        <DetailsTile status={status} />
        <ActivityTile events={events} />
        <McpTile baseUrl={baseUrl} />
      </div>
      <SectionNav
        sections={[
          { id: "dash-flow", label: "Flow" },
          { id: "dash-daemon", label: "Daemon" },
          { id: "dash-coverage", label: "Coverage" },
          { id: "dash-details", label: "Details" },
          { id: "dash-activity", label: "Activity" },
          { id: "dash-mcp", label: "MCP" },
        ]}
      />
    </section>
  );
}

// ---- hero --------------------------------------------------------------

function IndexFlowHero({
  totals,
  flowProjects,
  indexedProjects,
  discoveredProjects,
  daemonRunning,
}: {
  totals: { files: number; chunks: number };
  flowProjects: ReadonlyArray<FlowProject>;
  indexedProjects: number;
  discoveredProjects: number;
  daemonRunning: boolean;
}) {
  return (
    <article id="dash-flow" className="card hero">
      <header className="hero-head">
        <div>
          <p className="card-eyebrow">Index</p>
          <h2 className="card-title">
            Index
            <br />
            Flow
          </h2>
        </div>
        <span className={`daemon-status ${daemonRunning ? "ok" : "bad"}`}>
          <span className="dot-mark" />
          {daemonRunning ? "running" : "stopped"}
        </span>
      </header>

      <div className="hero-body">
        {flowProjects.length === 0 ? (
          <p className="dim" style={{ fontSize: "0.9rem", margin: "auto" }}>
            No projects discovered. Set <code>workspace_roots</code> in your config.
          </p>
        ) : (
          <FlowChart totalChunks={totals.chunks} projects={flowProjects} />
        )}
      </div>

      <footer className="hero-foot">
        <div className="hero-stat">
          <span>
            <span className="hero-stat-value">{indexedProjects}</span>
            <span className="hero-stat-unit">/ {discoveredProjects}</span>
          </span>
          <span className="hero-stat-label">Projects indexed</span>
        </div>
        <div className="hero-stat">
          <span>
            <span className="hero-stat-value">{totals.files.toLocaleString()}</span>
            <span className="hero-stat-unit">files</span>
          </span>
          <span className="hero-stat-label">{totals.chunks.toLocaleString()} chunks</span>
        </div>
      </footer>
    </article>
  );
}


// ---- daemon card -------------------------------------------------------

function DaemonCard({ status, baseUrl }: { status: StatusPayload; baseUrl: string }) {
  const daemon = status.daemon;
  return (
    <article id="dash-daemon" className="card daemon-card">
      <header>
        <p className="card-eyebrow">Daemon</p>
        <h3 className="card-title">{daemon.running ? "Online" : "Offline"}</h3>
      </header>
      <dl className="daemon-kv">
        {daemon.running ? (
          <>
            <dt>PID</dt>
            <dd>{daemon.pid}</dd>
            <dt>Endpoint</dt>
            <dd>{baseUrl}</dd>
            <dt>Version</dt>
            <dd>{daemon.version}</dd>
            <dt>Started</dt>
            <dd>{new Date(daemon.startedAt).toLocaleString()}</dd>
          </>
        ) : (
          <>
            <dt>State</dt>
            <dd>
              not running — start with <code>loctx start</code>
            </dd>
          </>
        )}
        <dt>Model</dt>
        <dd>{status.runtime.embeddingModel}</dd>
        <dt>Retrieval</dt>
        <dd>{status.runtime.retrievalMode}</dd>
      </dl>
    </article>
  );
}

// ---- coverage gauge ----------------------------------------------------

function CoverageGauge({
  percent,
  healthy,
  total,
}: {
  percent: number;
  healthy: number;
  total: number;
}) {
  // Half-circle gauge: stroke an arc from 180° → 0° (left → right across
  // the top half), fill clamped by `percent`. Using a 100x50 viewBox with
  // a stroke-dasharray-based fill on a single path keeps the markup tiny.
  const radius = 42;
  const cx = 50;
  const cy = 50;
  const arcLength = Math.PI * radius; // half-circle perimeter
  const fillLen = (Math.max(0, Math.min(100, percent)) / 100) * arcLength;

  return (
    <article id="dash-coverage" className="card gauge-card">
      <header>
        <p className="card-eyebrow">Coverage</p>
        <h3 className="card-title-sm">Index health</h3>
      </header>
      <div className="gauge-wrap">
        <svg className="gauge-svg" viewBox="0 0 100 60" aria-hidden="true">
          <title>{percent}% coverage</title>
          <path
            className="gauge-track"
            d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
          />
          <path
            className="gauge-fill"
            d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
            strokeDasharray={`${fillLen} ${arcLength}`}
          />
        </svg>
        <div className="gauge-readout">
          <span className="gauge-readout-value">{percent}</span>
          <span className="gauge-readout-unit">%</span>
        </div>
      </div>
      <div className="gauge-foot">
        <span>0%</span>
        <span>
          {healthy} of {total} indexed
        </span>
        <span>100%</span>
      </div>
    </article>
  );
}

// ---- tile row ----------------------------------------------------------

function DetailsTile({ status }: { status: StatusPayload }) {
  const r = status.runtime;
  const reconciliation =
    r.reconciliationIntervalSeconds === 0
      ? "off"
      : `${r.reconciliationIntervalSeconds}s${r.reconciliationRunOnStart ? " + boot" : ""}`;
  return (
    <article id="dash-details" className="card">
      <p className="card-eyebrow">Details</p>
      <div className="tile-grid">
        <Metric label="Mode" value={r.retrievalMode} />
        <Metric label="Embedding" value={r.embeddingModel} />
        <Metric label="Watcher" value={`${r.watcherDebounceMs}ms`} />
        <Metric label="Reconcile" value={reconciliation} />
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric" title={value}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

function ActivityTile({ events }: { events: ReadonlyArray<WatcherEvent> }) {
  return (
    <article id="dash-activity" className="card">
      <p className="card-eyebrow">Activity</p>
      {events.length === 0 ? (
        <p className="activity-empty">Idle — waiting for file events…</p>
      ) : (
        <ul className="activity">
          {events.map((e) => (
            <li key={`${e.at}-${e.projectName}-${e.relPath}`} className="activity-row">
              <span className="activity-time">
                {new Date(e.at).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={`activity-kind ${e.kind}`}>{e.kind}</span>
              <span className="activity-path">
                {e.projectName}/{e.relPath}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function McpTile({ baseUrl }: { baseUrl: string }) {
  const httpSnippet = JSON.stringify(
    { mcpServers: { loctx: { url: `${baseUrl}/mcp` } } },
    null,
    2,
  );
  const stdioSnippet = JSON.stringify(
    { mcpServers: { loctx: { command: "npx", args: ["loctx-mcp"] } } },
    null,
    2,
  );
  return (
    <article id="dash-mcp" className="card">
      <p className="card-eyebrow">MCP</p>
      <p className="card-title-sm">Client snippets</p>
      <p className="metric-label" style={{ marginTop: 0 }}>
        HTTP
      </p>
      <pre className="mcp-snippet">{httpSnippet}</pre>
      <p className="metric-label" style={{ marginTop: "var(--space-2)" }}>
        stdio
      </p>
      <pre className="mcp-snippet">{stdioSnippet}</pre>
    </article>
  );
}

// ---- watcher SSE -------------------------------------------------------

/**
 * Subscribe to /api/events and keep the most recent `n` events in memory.
 * Reuses the same SSE stream the LiveRefresh badge consumes; second
 * subscription is fine since the bus broadcasts.
 */
function useWatcherEvents(n: number): ReadonlyArray<WatcherEvent> {
  const [events, setEvents] = useState<WatcherEvent[]>([]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as Partial<WatcherEvent> & {
          at?: number;
          projectName?: string;
          relPath?: string;
          kind?: string;
        };
        if (
          typeof parsed.at !== "number" ||
          typeof parsed.projectName !== "string" ||
          typeof parsed.relPath !== "string" ||
          (parsed.kind !== "add" && parsed.kind !== "change" && parsed.kind !== "unlink")
        ) {
          return;
        }
        const event: WatcherEvent = {
          at: parsed.at,
          projectName: parsed.projectName,
          relPath: parsed.relPath,
          kind: parsed.kind,
        };
        setEvents((prev) => [event, ...prev].slice(0, n));
      } catch {
        /* malformed */
      }
    };
    return () => source.close();
  }, [n]);

  return events;
}
