/**
 * Interactive search over the local index.
 *
 * Uses a Server Action to call WorkspaceSearcher synchronously — no client
 * JavaScript beyond the form submission. Results render server-side. The
 * full Runtime (with embeddings) is built lazily on first search and
 * reused across requests.
 */

import { getAdminContext } from "@/lib/admin-context";
import { type Runtime, buildRuntime, inventoryProjects, loadConfig } from "@loctx/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One Runtime per server process. First search loads the embedding model
// (~90 MB download on a cold cache).
let runtimeP: Promise<Runtime> | null = null;

function getRuntime(): Promise<Runtime> {
  if (runtimeP === null) runtimeP = buildRuntime(loadConfig());
  return runtimeP;
}

interface SearchPageProps {
  searchParams: Promise<{ q?: string; path?: string; limit?: string; language?: string }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const path = params.path?.trim() || undefined;
  const limit = Number.parseInt(params.limit ?? "10", 10) || 10;
  const language = params.language?.trim() || undefined;

  const { state, discovery } = getAdminContext();
  const inventory = inventoryProjects(discovery, state);

  let response: Awaited<ReturnType<Runtime["searcher"]["search"]>> | null = null;
  let error: string | null = null;
  if (query) {
    try {
      const runtime = await getRuntime();
      response = await runtime.searcher.search({
        query,
        ...(path !== undefined ? { path } : {}),
        limit,
        ...(language !== undefined ? { language } : {}),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <section>
      <span className="eyebrow">Retrieval</span>
      <h1 className="display">Search</h1>
      <p className="subtitle">
        Vector + lexical search over the locally-indexed workspace. Scope by project root or any
        subtree.
      </p>

      <form method="GET" action="/search" className="search-form">
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
            defaultValue={path ?? ""}
            placeholder="project root or subtree"
          />
          <datalist id="loctx-project-paths">
            {inventory.active.map((a) => (
              <option key={a.project.id} value={a.project.root} label={a.project.name} />
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
            defaultValue={language ?? ""}
            style={{ width: "8rem" }}
          />
        </div>
        <button type="submit" className="btn btn-primary field-submit">
          Search
        </button>
      </form>

      {!query ? (
        <p className="pullquote">Enter a query to search the locally-indexed workspace.</p>
      ) : error !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
          {error}
        </p>
      ) : response === null ? null : (
        <Results response={response} />
      )}
    </section>
  );
}

function Results({
  response,
}: {
  response: Awaited<ReturnType<Runtime["searcher"]["search"]>>;
}) {
  if (response.results.length === 0) {
    return <p className="pullquote">No results.</p>;
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
      {response.warnings.map((w) => (
        <p
          key={w}
          className="pullquote"
          style={{ borderLeftColor: "var(--warn)", color: "var(--warn)" }}
        >
          {w}
        </p>
      ))}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {response.results.map((result) => (
          <li key={`${result.relPath}:${result.startLine}`} className="result">
            <div className="result-meta">
              <span className="result-score">{result.score.toFixed(3)}</span>
              <span className="result-path">
                {result.absPath ?? result.relPath}:{result.startLine}-{result.endLine}
              </span>
              <span className="result-tag">[{result.kind}]</span>
              {result.symbols.length > 0 ? (
                <span className="dim">{result.symbols.join(", ")}</span>
              ) : null}
            </div>
            <pre className="snippet">{clip(result.snippet, 14)}</pre>
          </li>
        ))}
      </ul>
    </>
  );
}

function clip(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n");
}
