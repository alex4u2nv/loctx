/**
 * Grouped find-literal result list, shared by the standalone
 * /find-literal page and the scoped panel on /projects/:id
 * (2026-08-06 audit, WEB-11 — the two renderers had drifted on the
 * grouping key and the chunk-kind tag; this keeps the standalone
 * page's richer rendering for both: project-qualified grouping +
 * `[chunkKind]` tag on each file group).
 *
 * Warnings are passed in (not read off the payload) so each surface
 * keeps its historical placement: the standalone page interleaves them
 * between the summary and the coverage note; the scoped panel shows
 * none.
 */

import type { FindLiteralPayload, LiteralHit } from "@shared/contracts";
import { Banner } from "./banner";

export interface LiteralResultsProps {
  readonly response: FindLiteralPayload;
  /**
   * Scope phrase for the empty state: "…of `pattern` {emptyWhere}."
   * Defaults to the workspace-wide wording.
   */
  readonly emptyWhere?: string;
  readonly warnings?: ReadonlyArray<string>;
}

export function LiteralResults({
  response,
  emptyWhere = "in any indexed chunk",
  warnings = [],
}: LiteralResultsProps) {
  const warningBanners = (
    <>
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}
    </>
  );
  if (response.matches.length === 0) {
    return (
      <>
        {warningBanners}
        <p className="pullquote">
          No occurrences of <code>{response.pattern}</code> {emptyWhere}.
          <br />
          <span className="dim">{response.coverageNote}</span>
        </p>
      </>
    );
  }
  // Group by project-qualified file so the result list reads like a
  // code-review pass: file header → each matched line under it.
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
      {warningBanners}
      <Banner tone="muted">
        <span className="dim">{response.coverageNote}</span>
      </Banner>
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
