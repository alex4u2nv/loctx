/**
 * Lightweight server-side context for admin pages.
 *
 * Admin views (status, /projects) only need to read config + StateStore +
 * WorkspaceDiscovery — they don't need the embedding model or Chroma.
 * Building those eagerly would download the HF model on every server boot
 * even for users who never click "search". This helper opens the cheap
 * pieces only and caches them across requests.
 *
 * Routes that *do* need search (/mcp, /search) build the full runtime via
 * `buildRuntime()` separately.
 */

import { type Config, StateStore, WorkspaceDiscovery, loadConfig } from "@loctx/core";

interface AdminContext {
  readonly config: Config;
  readonly state: StateStore;
  readonly discovery: WorkspaceDiscovery;
}

let cached: AdminContext | null = null;

export function getAdminContext(): AdminContext {
  if (cached !== null) return cached;
  const config = loadConfig();
  const state = new StateStore(config.paths.stateDb);
  const discovery = new WorkspaceDiscovery(config.workspaceRoots);
  cached = Object.freeze({ config, state, discovery });
  return cached;
}
