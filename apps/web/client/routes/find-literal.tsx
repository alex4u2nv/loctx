/**
 * `/find-literal` — UI for the audit-shape `find_literal` MCP tool
 * (#357 / #361). Companion to `/search` (ranked) and `/find-usages`
 * (exact symbol cross-ref). This page answers the "every file
 * containing `agents/foo.md`" / "every config still pointing at the
 * old URL" / "where is the deprecated constant still used"
 * question — every matched line, with file:line:column + the
 * coverageNote that reminds operators about chunker-gap blind spots.
 */

import type { FindLiteralPayload, LiteralHit } from "@shared/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SectionNav } from "../components/section-nav";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function FindLiteralPage() {
  const [params, setParams] = useSearchParams();
  const pattern = params.get("pattern")?.trim() ?? "";
  const path = params.get("path") ?? "";

  const [response, setResponse] = useState<FindLiteralPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const projectsCall = useFetch(() => api.projects(), []);

  const submit = useCallback(
    async (next: { pattern: string; path: string }) => {
      const newParams = new URLSearchParams();
      if (next.pattern) newParams.set("pattern", next.pattern);
      if (next.path) newParams.set("path", next.path);
      setParams(newParams);
      if (!next.pattern) {
        setResponse(null);
        return;
      }
      setLoading(true);
      try {
        const r = await api.findLiteral({
          pattern: next.pattern,
          ...(next.path ? { path: next.path } : {}),
        });
        setResponse(r);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResponse(null);
      } finally {
        setLoading(false);
      }
    },
    [setParams],
  );

  // URL-driven auto-fire on deep link / back-forward, same posture as
  // /search and /find-usages.
  const lastFired = useRef<string>("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — fire once per URL-derived state
  useEffect(() => {
    const key = `${pattern}|${path}`;
    if (!pattern || lastFired.current === key) return;
    lastFired.current = key;
    void submit({ pattern, path });
  }, [pattern, path]);

  return (
    <section>
      <span className="eyebrow">Audit</span>
      <h1 className="display">Find literal</h1>
      <p className="subtitle">
        Exhaustive substring search across indexed chunk text. Use for audits where every
        occurrence matters: stale file-path references, deprecated config keys, dead
        deprecation-marker strings. Distinct from <code>search</code> (ranked retrieval) and{" "}
        <code>find-usages</code> (exact code symbol). For total file coverage on
        safety-critical audits, supplement with <code>rg</code>.
      </p>

      <div className="card-stack">
      <div className="card" id="fl-query">
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void submit({
            pattern: String(fd.get("pattern") ?? "").trim(),
            path: String(fd.get("path") ?? "").trim(),
          });
        }}
      >
        <div className="field">
          <label htmlFor="pattern">pattern</label>
          <input
            id="pattern"
            className="input"
            type="text"
            name="pattern"
            defaultValue={pattern}
            placeholder="literal substring — paths, urls, identifiers, anything"
          />
        </div>
        <div className="field">
          <label htmlFor="path">path</label>
          <input
            id="path"
            className="input"
            type="text"
            name="path"
            list="loctx-project-paths"
            defaultValue={path}
            placeholder="project root or subtree"
          />
          <datalist id="loctx-project-paths">
            {projectsCall.data?.active.flatMap((a) => [
              <option key={a.id} value={a.root} label={a.name} />,
              ...["src", "apps", "packages", "lib", "tests"].map((sub) => (
                <option
                  key={`${a.id}:${sub}`}
                  value={`${a.root}/${sub}`}
                  label={`${a.name}/${sub}`}
                />
              )),
            ])}
          </datalist>
        </div>
        <button type="submit" className="btn btn-primary field-submit" disabled={loading}>
          {loading ? "Scanning…" : "Find"}
        </button>
      </form>
      </div>

      {error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : null}

      <div className="card" id="fl-results">
      {error !== null ? null : response === null ? (
        pattern ? null : (
          <p className="pullquote">
            Enter a literal substring to scan the indexed workspace. Tokens, paths, full lines —
            anything that should be found verbatim.
          </p>
        )
      ) : (
        <Results response={response} />
      )}
      </div>
      </div>
      {response !== null ? (
        <SectionNav
          sections={[
            { id: "fl-query", label: "Query" },
            { id: "fl-results", label: "Results" },
          ]}
        />
      ) : null}
    </section>
  );
}

function Results({ response }: { response: FindLiteralPayload }) {
  const warnings = (
    <>
      {response.warnings.map((w) => (
        <p
          key={w}
          className="pullquote"
          style={{ borderLeftColor: "var(--warn)", color: "var(--warn)" }}
        >
          {w}
        </p>
      ))}
    </>
  );
  if (response.matches.length === 0) {
    return (
      <>
        {warnings}
        <p className="pullquote">
          No occurrences of <code>{response.pattern}</code> in any indexed chunk.
          <br />
          <span className="dim">{response.coverageNote}</span>
        </p>
      </>
    );
  }
  // Group by file so the result list reads like a code-review pass:
  // file header → each matched line under it. Easier to eyeball than
  // a flat per-line list.
  const byFile = new Map<string, LiteralHit[]>();
  for (const m of response.matches) {
    const key = `${m.projectName}:${m.relPath}`;
    const arr = byFile.get(key) ?? [];
    arr.push(m);
    byFile.set(key, arr);
  }
  return (
    <>
      <p className="summary">
        {response.matches.length} occurrence{response.matches.length === 1 ? "" : "s"} across{" "}
        {response.fileCount} file{response.fileCount === 1 ? "" : "s"}
      </p>
      {warnings}
      <p className="pullquote" style={{ borderLeftColor: "var(--muted)" }}>
        <span className="dim">{response.coverageNote}</span>
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {Array.from(byFile.entries()).map(([key, hits]) => {
          const first = hits[0];
          if (first === undefined) return null;
          return (
            <li key={key} className="result">
              <div className="result-meta">
                <span className="result-path">
                  {first.projectName}/{first.relPath}
                </span>
                <span className="result-tag">[{first.chunkKind}]</span>
                <span className="dim">
                  {hits.length} hit{hits.length === 1 ? "" : "s"}
                </span>
              </div>
              <pre className="snippet">
                {hits.map((h) => `${h.line}:${h.column}\t${h.lineText}`).join("\n")}
              </pre>
            </li>
          );
        })}
      </ul>
    </>
  );
}
