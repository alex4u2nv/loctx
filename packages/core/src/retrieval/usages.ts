/**
 * Shared "find usages of a symbol" core (#449).
 *
 * The resolve-scope → findSymbol sweep existed in three places — the MCP
 * registry, the web REST endpoint, and the CLI's no-daemon fallback —
 * and only the MCP copy used {@link resolveProjectScope}. The other two
 * used plain `discovery.resolveProject`, so a path inside an unindexed
 * inner package (the #276 monorepo case) found usages via the MCP tool
 * but silently returned nothing (or 404) via REST and the CLI. All three
 * surfaces now call this one function; only response shaping stays local.
 */

import type { WorkspaceDiscovery } from "../discovery.js";
import type { Project } from "../models.js";
import type { StateStore, SymbolRefHit } from "../storage/state.js";
import { resolveProjectScope } from "./searcher.js";

export interface SymbolUsageProject {
  readonly project: Project;
  readonly defs: ReadonlyArray<SymbolRefHit>;
  readonly refs: ReadonlyArray<SymbolRefHit>;
}

/**
 * `outside-indexed`: a `path` was given but no indexed project contains
 * it. Callers pick their own surface semantics — the MCP tool throws a
 * ToolError, the REST endpoint returns 404, the CLI prints and exits.
 */
export type SymbolUsages =
  | { readonly kind: "outside-indexed"; readonly warnings: ReadonlyArray<string> }
  | {
      readonly kind: "ok";
      readonly projects: ReadonlyArray<SymbolUsageProject>;
      readonly warnings: ReadonlyArray<string>;
    };

export function findSymbolUsages(
  discovery: Pick<WorkspaceDiscovery, "resolveProject" | "discoverProjects">,
  state: Pick<StateStore, "listProjects" | "findSymbol">,
  symbol: string,
  path?: string,
): SymbolUsages {
  const warnings: string[] = [];
  let projects: ReadonlyArray<Project>;
  if (path !== undefined) {
    // Prefers the deepest *indexed* ancestor over an unindexed inner
    // marker (#276), warning when it widens the scope.
    const scope = resolveProjectScope(discovery, state, path, warnings);
    if (scope.project === null) {
      return Object.freeze({ kind: "outside-indexed", warnings: Object.freeze(warnings) });
    }
    projects = [scope.project];
  } else {
    projects = discovery.discoverProjects();
  }

  const out: SymbolUsageProject[] = [];
  for (const project of projects) {
    const { defs, refs } = state.findSymbol(project.id, symbol);
    if (defs.length === 0 && refs.length === 0) continue;
    out.push({ project, defs, refs });
  }
  return Object.freeze({
    kind: "ok",
    projects: Object.freeze(out),
    warnings: Object.freeze(warnings),
  });
}
