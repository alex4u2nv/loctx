import type { SearchHit, SearchPayload } from "@shared/contracts";
import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AsyncError } from "../components/async-boundary";
import { Banner } from "../components/banner";
import { CodeBlock } from "../components/code-block";
import {
  PROJECT_PATHS_DATALIST_ID,
  ProjectPathsDatalist,
} from "../components/project-paths-datalist";
import { QueryForm } from "../components/query-form";
import { SearchTabs } from "../components/search-tabs";
import { SectionNav } from "../components/section-nav";
import { SnippetModal } from "../components/snippet-modal";
import { api } from "../lib/api";
import { SEARCH_DEFAULT_LIMIT, type SearchQuery, searchCodec } from "../lib/query-codecs";
import { useFetch } from "../lib/use-fetch";
import { useSnippetSelection } from "../lib/use-snippet-selection";
import { useUrlQuery } from "../lib/use-url-query";

export function SearchPage() {
  // URL-driven query state machine (audit WEB-2): params→state, submit
  // mirrors to the URL, deep-links/back-forward auto-fire exactly once.
  const { params, data, error, busy, submit } = useUrlQuery(searchCodec, (req: SearchQuery) =>
    api.search({
      query: req.q,
      ...(req.path ? { path: req.path } : {}),
      limit: req.limit,
      ...(req.language ? { language: req.language } : {}),
      ...(req.coverage ? { coverage: true } : {}),
    }),
  );
  const query = params.get("q")?.trim() ?? "";
  const path = params.get("path") ?? "";
  const limit =
    Number.parseInt(params.get("limit") ?? String(SEARCH_DEFAULT_LIMIT), 10) ||
    SEARCH_DEFAULT_LIMIT;
  const language = params.get("language") ?? "";
  const coverage = params.get("coverage") === "1";

  const projectsCall = useFetch(() => api.projects(), []);

  return (
    <section>
      <span className="eyebrow">Retrieval</span>
      <h1 className="display">Search</h1>
      <p className="subtitle">
        Vector + lexical search over the locally-indexed workspace. Scope by project root or any
        subtree.
      </p>

      <SearchTabs />

      <div className="card-stack">
        <div className="card" id="search-query">
          <QueryForm
            // Re-mount when URL params change so the uncontrolled inputs pick
            // up fresh defaultValues (e.g. after "narrow to this subtree").
            key={`${query}|${path}|${limit}|${language}|${coverage}`}
            busy={busy}
            submitLabel="Search"
            busyLabel="Searching…"
            fields={[
              {
                id: "q",
                name: "q",
                label: "query",
                defaultValue: query,
                placeholder: "natural language or code fragment",
              },
              {
                id: "path",
                name: "path",
                label: "path",
                datalist: PROJECT_PATHS_DATALIST_ID,
                defaultValue: path,
                placeholder: "project root or subtree",
              },
              {
                id: "limit",
                name: "limit",
                label: "limit",
                type: "number",
                min: 1,
                max: 100,
                defaultValue: String(limit),
                width: "5rem",
              },
              {
                id: "language",
                name: "language",
                label: "language",
                placeholder: "any",
                defaultValue: language,
                width: "8rem",
              },
              {
                id: "coverage",
                name: "coverage",
                label: "coverage",
                type: "checkbox",
                defaultChecked: coverage,
                title:
                  "Expand top hits with their callers + importers via the symbol cross-reference graph. Useful for refactor planning ('what else touches X')",
              },
            ]}
            onSubmit={(values) =>
              submit({
                q: values["q"] ?? "",
                path: values["path"] ?? "",
                limit:
                  Number.parseInt(values["limit"] ?? String(SEARCH_DEFAULT_LIMIT), 10) ||
                  SEARCH_DEFAULT_LIMIT,
                language: values["language"] ?? "",
                coverage: values["coverage"] === "on",
              })
            }
          />
          <ProjectPathsDatalist projects={projectsCall.data?.active} />
        </div>

        {error !== null ? <AsyncError error={error} /> : null}

        <div className="card" id="search-results">
          {error !== null ? null : data === null ? (
            query ? null /* URL-driven submit is in flight; brief blank is OK */ : (
              <p className="pullquote">Enter a query to search the locally-indexed workspace.</p>
            )
          ) : (
            <Results response={data} />
          )}
        </div>
      </div>
      {data !== null ? (
        <SectionNav
          sections={[
            { id: "search-query", label: "Query" },
            { id: "search-results", label: "Results" },
          ]}
        />
      ) : null}
    </section>
  );
}

function Results({ response }: { response: SearchPayload }) {
  const { selected, open, close } = useSnippetSelection<SearchHit>();
  const [, setParams] = useSearchParams();
  const narrowTo = useCallback(
    (absPath: string | null) => {
      // Use the hit's absolute path's directory as the new subtree
      // scope. Single-file scopes aren't useful here so we strip the
      // basename. Falls back to no-op when absPath isn't present
      // (shouldn't happen for indexed hits, but the type allows it).
      if (absPath === null) return;
      const slash = absPath.lastIndexOf("/");
      if (slash === -1) return;
      const target = absPath.slice(0, slash);
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("path", target);
        return next;
      });
    },
    [setParams],
  );
  const warnings = (
    <>
      {response.warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
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
          <li key={`${r.relPath}:${r.startLine}`} className="result result-card">
            <div className="result-card-head">
              <button
                type="button"
                className="result-card-path"
                onClick={() => open(r)}
                title="Click to view the full syntax-highlighted snippet"
              >
                {r.absPath ?? r.relPath}
                <span className="result-card-lines">
                  :{r.startLine}-{r.endLine}
                </span>
              </button>
              <span className="result-badge" title={`relevance score ${r.score.toFixed(3)}`}>
                {r.score.toFixed(3)}
              </span>
            </div>
            <div className="result-meta">
              <span className="result-tag">[{r.kind}]</span>
              {r.symbols.length > 0 ? (
                <span className="dim">
                  {r.symbols.map((s, i) => (
                    <span key={s}>
                      {i > 0 ? ", " : ""}
                      {r.kind.startsWith("section") ? (
                        // Markdown section chunks expose the heading path as
                        // "symbols" (never in the symbol_refs cross-ref graph),
                        // so find-usages returns nothing — search instead. We
                        // key on `kind` (always set) not `language` (the
                        // lexical branch can leave it empty).
                        <Link
                          className="btn-link"
                          to={`/search?q=${encodeURIComponent(s)}`}
                          title={`search for "${s}"`}
                        >
                          {s}
                        </Link>
                      ) : (
                        // Real code symbol from the tree-sitter chunker.
                        <Link
                          className="btn-link"
                          to={`/find-usages?symbol=${encodeURIComponent(s)}`}
                          title={`find usages of ${s}`}
                        >
                          {s}
                        </Link>
                      )}
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
            {r.coverageReason !== null ? (
              <div
                className="dim"
                style={{ marginTop: "0.25rem", fontSize: "0.85em", color: "var(--accent)" }}
              >
                via coverage: {r.coverageReason}
              </div>
            ) : null}
            {r.absPath !== null ? (
              <div style={{ marginTop: "0.25rem", fontSize: "0.85em" }}>
                <button
                  type="button"
                  className="btn-link dim"
                  onClick={() => narrowTo(r.absPath)}
                  title={`Re-run scoped to ${r.relPath.includes("/") ? r.relPath.slice(0, r.relPath.lastIndexOf("/")) : r.projectName}/`}
                >
                  ↳ narrow to this subtree
                </button>
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
            <CodeBlock snippet={r.snippet} startLine={r.startLine} maxLines={14} />
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
        No results across every indexed project. The query may be too specific, or the term may not
        appear in indexed content.
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
      No results in <code>{scopeLabel}</code>. Try removing the path filter to search every project,
      or check the query spelling.
    </p>
  );
}
