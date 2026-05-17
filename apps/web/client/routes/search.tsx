import type { SearchHit, SearchPayload } from "@shared/contracts";
import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SnippetModal } from "../components/snippet-modal";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";
import { useSnippetSelection } from "../lib/use-snippet-selection";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q")?.trim() ?? "";
  const path = params.get("path") ?? "";
  const limit = Number.parseInt(params.get("limit") ?? "10", 10) || 10;
  const language = params.get("language") ?? "";

  const [response, setResponse] = useState<SearchPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const projectsCall = useFetch(() => api.projects(), []);

  const submit = useCallback(
    async (next: { q: string; path: string; limit: number; language: string }) => {
      const newParams = new URLSearchParams();
      if (next.q) newParams.set("q", next.q);
      if (next.path) newParams.set("path", next.path);
      if (next.limit !== 10) newParams.set("limit", String(next.limit));
      if (next.language) newParams.set("language", next.language);
      setParams(newParams);
      if (!next.q) {
        setResponse(null);
        return;
      }
      setLoading(true);
      try {
        const r = await api.search({
          query: next.q,
          ...(next.path ? { path: next.path } : {}),
          limit: next.limit,
          ...(next.language ? { language: next.language } : {}),
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

  return (
    <section>
      <span className="eyebrow">Retrieval</span>
      <h1 className="display">Search</h1>
      <p className="subtitle">
        Vector + lexical search over the locally-indexed workspace. Scope by project root or any
        subtree.
      </p>

      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void submit({
            q: String(fd.get("q") ?? "").trim(),
            path: String(fd.get("path") ?? "").trim(),
            limit: Number.parseInt(String(fd.get("limit") ?? "10"), 10) || 10,
            language: String(fd.get("language") ?? "").trim(),
          });
        }}
      >
        <div className="field">
          <label htmlFor="q">query</label>
          <input
            id="q"
            className="input"
            type="text"
            name="q"
            defaultValue={query}
            placeholder="natural language or code fragment"
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
            {projectsCall.data?.active.map((a) => (
              <option key={a.id} value={a.root} label={a.name} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="limit">limit</label>
          <input
            id="limit"
            className="input"
            type="number"
            name="limit"
            min={1}
            max={100}
            defaultValue={limit}
            style={{ width: "5rem" }}
          />
        </div>
        <div className="field">
          <label htmlFor="language">language</label>
          <input
            id="language"
            className="input"
            type="text"
            name="language"
            placeholder="any"
            defaultValue={language}
            style={{ width: "8rem" }}
          />
        </div>
        <button type="submit" className="btn btn-primary field-submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : response === null ? (
        query ? (
          loading ? null : (
            <p className="pullquote">No results yet.</p>
          )
        ) : (
          <p className="pullquote">Enter a query to search the locally-indexed workspace.</p>
        )
      ) : (
        <Results response={response} />
      )}
    </section>
  );
}

function Results({ response }: { response: SearchPayload }) {
  const { selected, open, close } = useSnippetSelection<SearchHit>();
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
  if (response.results.length === 0) {
    return (
      <>
        {warnings}
        <NoResults response={response} />
      </>
    );
  }
  return (
    <>
      <p className="summary">
        {response.results.length} result{response.results.length === 1 ? "" : "s"}
        <span className="sep">·</span>
        scope: {response.resolvedScope.mode}
        {response.resolvedScope.project ? ` (${response.resolvedScope.project.name})` : ""}
        {response.resolvedScope.relPrefix ? (
          <>
            <span className="sep">·</span>
            {response.resolvedScope.relPrefix}
          </>
        ) : null}
      </p>
      {warnings}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {response.results.map((r) => (
          <li key={`${r.relPath}:${r.startLine}`} className="result">
            <div className="result-meta">
              <span className="result-score">{r.score.toFixed(3)}</span>
              <button
                type="button"
                className="result-path btn-link"
                onClick={() => open(r)}
                title="Click to view full snippet"
              >
                {r.absPath ?? r.relPath}:{r.startLine}-{r.endLine}
              </button>
              <span className="result-tag">[{r.kind}]</span>
              {r.symbols.length > 0 ? (
                <span className="dim">
                  {r.symbols.map((s, i) => (
                    <span key={s}>
                      {i > 0 ? ", " : ""}
                      <Link
                        className="btn-link"
                        to={`/find-usages?symbol=${encodeURIComponent(s)}`}
                        title={`find usages of ${s}`}
                      >
                        {s}
                      </Link>
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
            {r.matchReasons.length > 0 ? (
              <div className="dim" style={{ marginTop: "0.25rem", fontSize: "0.85em" }}>
                why: {r.matchReasons.join(", ")}
              </div>
            ) : null}
            {r.enrichments.lizard !== null ? (
              <div className="dim" style={{ marginTop: "0.25rem", fontSize: "0.85em" }}>
                complexity: fn={r.enrichments.lizard.functionName} ccn={r.enrichments.lizard.ccn}{" "}
                nloc={r.enrichments.lizard.nloc}
              </div>
            ) : null}
            {r.enrichments.findings.map((f, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: findings array is stable per-result
                key={`f-${i}`}
                className="dim"
                style={{ marginTop: "0.25rem", fontSize: "0.85em" }}
              >
                {f.analyzer} {f.severity} {f.ruleId} L{f.lineFrom}-{f.lineTo}
                {f.message ? `: ${f.message}` : ""}
              </div>
            ))}
            <pre className="snippet">{clip(r.snippet, 14)}</pre>
          </li>
        ))}
      </ul>
      {selected !== null ? (
        <SnippetModal
          title={selected.absPath ?? selected.relPath}
          snippet={selected.snippet}
          language={selected.language}
          onClose={close}
          meta={
            <span className="dim">
              lines {selected.startLine}-{selected.endLine}
              <span className="sep">·</span>
              {selected.kind}
              {selected.symbols.length > 0 ? (
                <>
                  <span className="sep">·</span>
                  {selected.symbols.join(", ")}
                </>
              ) : null}
            </span>
          }
        />
      ) : null}
    </>
  );
}

/**
 * Zero-result explainer (#45). The original UI said only "No results"
 * which left the user unable to distinguish "query is bad" from "scope
 * is too narrow." When the resolver narrowed to a specific project or
 * subtree, surface the active scope and offer a one-click broaden.
 */
function NoResults({ response }: { response: SearchPayload }) {
  const scope = response.resolvedScope;
  // Warnings (including any reconcile note) are already rendered above
  // this empty state by the parent; don't duplicate them.
  if (scope.mode === "all") {
    return (
      <p className="pullquote">
        No results across every indexed project. The query may be too specific, or the term may
        not appear in indexed content.
      </p>
    );
  }
  const scopeLabel =
    scope.relPrefix !== null
      ? `${scope.project?.name ?? ""}/${scope.relPrefix.replace(/\/$/, "")}`
      : (scope.project?.name ?? "the active scope");
  // The form is the parent's responsibility, so we point at a route
  // that clears the path/language filters rather than mutating state
  // here.
  return (
    <p className="pullquote">
      No results in <code>{scopeLabel}</code>. Try removing the path filter to search every
      project, or check the query spelling.
    </p>
  );
}

function clip(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n");
}
