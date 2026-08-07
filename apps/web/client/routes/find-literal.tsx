/**
 * `/find-literal` — UI for the audit-shape `find_literal` MCP tool
 * (#357 / #361). Companion to `/search` (ranked) and `/find-usages`
 * (exact symbol cross-ref). This page answers the "every file
 * containing `agents/foo.md`" / "every config still pointing at the
 * old URL" / "where is the deprecated constant still used"
 * question — every matched line, with file:line:column + the
 * coverageNote that reminds operators about chunker-gap blind spots.
 */

import { AsyncError } from "../components/async-boundary";
import { LiteralResults } from "../components/literal-results";
import {
  PROJECT_PATHS_DATALIST_ID,
  ProjectPathsDatalist,
} from "../components/project-paths-datalist";
import { QueryForm } from "../components/query-form";
import { SearchTabs } from "../components/search-tabs";
import { SectionNav } from "../components/section-nav";
import { api } from "../lib/api";
import { type FindLiteralQuery, findLiteralCodec } from "../lib/query-codecs";
import { useFetch } from "../lib/use-fetch";
import { useUrlQuery } from "../lib/use-url-query";

export function FindLiteralPage() {
  // URL-driven query state machine (audit WEB-2): same posture as
  // /search and /find-usages — deep-links / back-forward auto-fire once.
  const { params, data, error, busy, submit } = useUrlQuery(
    findLiteralCodec,
    (req: FindLiteralQuery) =>
      api.findLiteral({ pattern: req.pattern, ...(req.path ? { path: req.path } : {}) }),
  );
  const pattern = params.get("pattern")?.trim() ?? "";
  const path = params.get("path") ?? "";

  const projectsCall = useFetch(() => api.projects(), []);

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

      <SearchTabs />

      <div className="card-stack">
      <div className="card" id="fl-query">
      <QueryForm
        // Re-mount when URL params change so the uncontrolled inputs pick
        // up fresh defaultValues on deep-link / back-forward.
        key={`${pattern}|${path}`}
        busy={busy}
        submitLabel="Find"
        busyLabel="Scanning…"
        fields={[
          {
            id: "pattern",
            name: "pattern",
            label: "pattern",
            defaultValue: pattern,
            placeholder: "literal substring — paths, urls, identifiers, anything",
          },
          {
            id: "path",
            name: "path",
            label: "path",
            datalist: PROJECT_PATHS_DATALIST_ID,
            defaultValue: path,
            placeholder: "project root or subtree",
          },
        ]}
        onSubmit={(values) =>
          submit({ pattern: values["pattern"] ?? "", path: values["path"] ?? "" })
        }
      />
      <ProjectPathsDatalist projects={projectsCall.data?.active} />
      </div>

      {error !== null ? <AsyncError error={error} /> : null}

      <div className="card" id="fl-results">
      {error !== null ? null : data === null ? (
        pattern ? null : (
          <p className="pullquote">
            Enter a literal substring to scan the indexed workspace. Tokens, paths, full lines —
            anything that should be found verbatim.
          </p>
        )
      ) : (
        <LiteralResults response={data} warnings={data.warnings} />
      )}
      </div>
      </div>
      {data !== null ? (
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
