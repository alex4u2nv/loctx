/**
 * `/duplicates` inspector: exact token-window duplicate groups plus
 * embedding-based semantic near-duplicate groups (#523) for one
 * project. Mirrors the MCP `find_duplicates` tool so the two surfaces
 * can be compared while testing. Provisioning (enable/tune) stays on
 * the Analyzers tab; this page only reads.
 */

import type { DuplicatesPayload, ProjectsPayload } from "@shared/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AsyncError, AsyncLoading } from "../components/async-boundary";
import { Banner } from "../components/banner";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function DuplicatesPage() {
  const projects = useFetch(() => api.projects(), []);
  const [projectId, setProjectId] = useState("");
  const [minMembers, setMinMembers] = useState(2);
  const [result, setResult] = useState<DuplicatesPayload | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = activeProjects(projects.data);
  // Default the selector to the first indexed project once loaded.
  useEffect(() => {
    if (projectId === "" && active.length > 0) setProjectId(active[0]?.id ?? "");
  }, [projectId, active]);

  const run = async (): Promise<void> => {
    if (projectId === "") return;
    setRunning(true);
    setError(null);
    try {
      setResult(await api.findDuplicates(projectId, minMembers));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (projects.loading && projects.data === null) return <AsyncLoading />;
  if (projects.error !== null) return <AsyncError error={projects.error} />;

  return (
    <section>
      <span className="eyebrow">Search</span>
      <h1 className="display">Duplicates</h1>
      <p className="subtitle">
        Exact token-window duplicate groups and embedding-based near-duplicates ("same meaning,
        different text") for one project. Same data as the MCP <code>find_duplicates</code> tool.
      </p>

      <div className="card" style={{ display: "flex", gap: "var(--space-3)", alignItems: "end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span className="dim" style={{ fontSize: "0.8rem" }}>
            Project
          </span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span className="dim" style={{ fontSize: "0.8rem" }}>
            Min files per group
          </span>
          <input
            type="number"
            min={2}
            max={50}
            value={minMembers}
            onChange={(e) => setMinMembers(Number(e.target.value))}
            style={{ width: "6rem" }}
          />
        </label>
        <button type="button" className="btn" disabled={running || projectId === ""} onClick={() => void run()}>
          {running ? "Scanning…" : "Find duplicates"}
        </button>
      </div>

      {error !== null ? <Banner tone="bad">{error}</Banner> : null}
      {result !== null ? <Results data={result} /> : null}
    </section>
  );
}

function activeProjects(
  data: ProjectsPayload | null,
): ReadonlyArray<{ readonly id: string; readonly name: string }> {
  if (data === null) return [];
  return data.active.map((p) => ({ id: p.id, name: p.name }));
}

function Results({ data }: { data: DuplicatesPayload }) {
  return (
    <>
      {data.warnings.map((w) => (
        <Banner key={w} tone="warn" soft>
          {w}
        </Banner>
      ))}

      <h2>Exact groups ({data.groups.length})</h2>
      {data.disabled !== null ? (
        <Banner tone="warn" soft>
          {data.disabled} Configure on the <Link to="/analyzers">Analyzers</Link> tab.
        </Banner>
      ) : data.groups.length === 0 ? (
        <p className="dim">No token-window duplicates at this group size.</p>
      ) : (
        data.groups.map((g) => (
          <div className="card" key={g.hash}>
            <p className="card-section-title">
              <code>{g.hash.slice(0, 12)}</code> · {g.members.length} occurrences
            </p>
            <MemberList members={g.members} />
          </div>
        ))
      )}

      <h2>
        Semantic groups
        {data.semantic !== null ? ` (${data.semantic.groups.length})` : ""}
      </h2>
      {data.semanticDisabled !== null ? (
        <Banner tone="warn" soft>
          {data.semanticDisabled} Configure on the <Link to="/analyzers">Analyzers</Link> tab.
        </Banner>
      ) : data.semantic === null || data.semantic.groups.length === 0 ? (
        <p className="dim">
          No semantic near-duplicates above the configured similarity threshold
          {data.semantic !== null ? ` (${data.semantic.scanned} chunks scanned)` : ""}.
        </p>
      ) : (
        data.semantic.groups.map((g, i) => (
          <div className="card" key={`${g.similarity}-${g.members[0]?.fileId ?? i}`}>
            <p className="card-section-title">
              similarity {g.similarity} · {g.files} files
            </p>
            <MemberList members={g.members} />
          </div>
        ))
      )}
    </>
  );
}

function MemberList({
  members,
}: {
  members: ReadonlyArray<{ relPath: string; startLine: number; endLine: number; fileId: string }>;
}) {
  return (
    <ul style={{ margin: 0 }}>
      {members.map((m) => (
        <li key={`${m.fileId}:${m.startLine}`}>
          <code>
            {m.relPath}:{m.startLine}-{m.endLine}
          </code>
        </li>
      ))}
    </ul>
  );
}
