/**
 * Interactive search over the local index.
 *
 * Uses a Server Action to call WorkspaceSearcher synchronously — no client
 * JavaScript beyond the form submission. Results render server-side. The
 * full Runtime (with embeddings) is built lazily on first search and
 * reused across requests.
 */

import { type Runtime, type Scope, buildRuntime, loadConfig } from "@loctx/core";

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
  searchParams: Promise<{ q?: string; scope?: string; limit?: string; language?: string }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const scope = (params.scope as Scope | undefined) ?? "auto";
  const limit = Number.parseInt(params.limit ?? "10", 10) || 10;
  const language = params.language?.trim() || undefined;

  let response: Awaited<ReturnType<Runtime["searcher"]["search"]>> | null = null;
  let error: string | null = null;
  if (query) {
    try {
      const runtime = await getRuntime();
      response = await runtime.searcher.search({
        query,
        scope,
        limit,
        ...(language !== undefined ? { language } : {}),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Search</h1>

      <form
        method="GET"
        action="/search"
        style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}
      >
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="natural language or code fragment"
          style={{
            flex: "1 1 320px",
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #1f2540",
            background: "#11173a",
            color: "#e6e8ef",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }}
        />
        <select
          name="scope"
          defaultValue={scope}
          style={{
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #1f2540",
            background: "#11173a",
            color: "#e6e8ef",
          }}
        >
          <option value="auto">auto</option>
          <option value="all">all</option>
          <option value="project">project</option>
          <option value="subtree">subtree</option>
        </select>
        <input
          type="number"
          name="limit"
          min={1}
          max={100}
          defaultValue={limit}
          style={{
            width: 80,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #1f2540",
            background: "#11173a",
            color: "#e6e8ef",
          }}
        />
        <input
          type="text"
          name="language"
          placeholder="language"
          defaultValue={language ?? ""}
          style={{
            width: 120,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #1f2540",
            background: "#11173a",
            color: "#e6e8ef",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid #4a5fff",
            background: "#1d2a8a",
            color: "#e6e8ef",
            cursor: "pointer",
          }}
        >
          search
        </button>
      </form>

      {!query ? (
        <p style={{ color: "#7a85b8" }}>Enter a query to search the locally-indexed workspace.</p>
      ) : error !== null ? (
        <p style={{ color: "#ff9b9b" }}>error: {error}</p>
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
    return <p style={{ color: "#7a85b8" }}>No results.</p>;
  }
  return (
    <>
      <p style={{ color: "#7a85b8", marginTop: 0 }}>
        {response.results.length} result(s) · scope: {response.resolvedScope.mode}
        {response.resolvedScope.project ? ` (${response.resolvedScope.project.name})` : ""}
      </p>
      {response.warnings.map((w) => (
        <p key={w} style={{ color: "#ffd97a", margin: "0 0 12px" }}>
          {w}
        </p>
      ))}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {response.results.map((result) => (
          <li
            key={`${result.relPath}:${result.startLine}`}
            style={{
              borderBottom: "1px solid #1f2540",
              padding: "12px 0",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 12,
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 13,
                color: "#9ba3c4",
              }}
            >
              <span style={{ color: "#7a85b8" }}>{result.score.toFixed(3)}</span>
              <span style={{ color: "#e6e8ef" }}>
                {result.relPath}:{result.startLine}-{result.endLine}
              </span>
              <span>[{result.kind}]</span>
              {result.symbols.length > 0 ? <span>{result.symbols.join(", ")}</span> : null}
            </div>
            <pre
              style={{
                marginTop: 8,
                padding: 12,
                background: "#11173a",
                borderRadius: 6,
                overflow: "auto",
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              {clip(result.snippet, 14)}
            </pre>
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
