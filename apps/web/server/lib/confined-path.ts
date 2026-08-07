/**
 * Workspace-root confinement for path-accepting routes (SRV-4).
 *
 * The same three-line block was copy-pasted 8× across search,
 * find-usages, find-literal, projects (activate/deactivate) and ops
 * (index/reset/rebuild). One helper keeps the 403 contract identical
 * everywhere and is the mechanism that stops the next path-accepting
 * route shipping without the guard (the SRV-1 failure mode).
 */

import { type Config, resolveUnderWorkspaceRoots } from "@loctx/core";
import { ForbiddenError } from "./http-errors.js";

/**
 * Resolve `raw` under the configured workspace roots, or throw the
 * uniform 403. Returns the canonicalized path so callers scope against
 * the resolved form.
 */
export function confinedPath(config: Config, raw: string): string {
  const confined = resolveUnderWorkspaceRoots(raw, config.workspaceRoots);
  if (confined === null) {
    throw new ForbiddenError("path is not under any configured workspace_root");
  }
  return confined;
}
