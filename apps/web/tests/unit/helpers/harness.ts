/**
 * In-memory harness for server route unit tests. Mounts a single route
 * module onto a throwaway Hono app with a faked Config + Runtime, so
 * app.request() drives the real handler logic (validation, path
 * confinement, response shaping) without a daemon, DB, ports, or model.
 */

import type { Config, Runtime } from "@loctx/core";
import { Hono } from "hono";
import { registerErrorBoundary } from "../../../server/lib/http-errors.js";

/**
 * Minimal Config. Only the fields the API routes actually read are
 * populated; the rest are cast away. Pass `workspaceRoots` (a real tmp
 * dir) when a route does path-confinement so realpath containment works.
 */
export function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    workspaceRoots: [],
    source: null,
    paths: {
      dataDir: "/tmp/loctx-test-data",
      configDir: "/tmp/loctx-test-cfg",
      stateDb: "/tmp/loctx-test-data/state.sqlite3",
      vectorDir: "/tmp/loctx-test-data/vectors",
      logDir: "/tmp/loctx-test-data/logs",
    },
    ...overrides,
  } as unknown as Config;
}

type ReconcileStatus = ReturnType<Runtime["reconciler"]["status"]>;

const IDLE_RECONCILE = {
  running: false,
  startedAt: null,
  currentProjectId: null,
  currentProjectName: null,
  completed: 0,
  total: 0,
  currentProjectIndexed: null,
  currentProjectTotal: null,
} as unknown as ReconcileStatus;

export interface FakeRuntimeParts {
  readonly searcher?: Partial<Runtime["searcher"]>;
  readonly discovery?: Partial<Runtime["discovery"]>;
  readonly state?: Partial<Runtime["state"]>;
  readonly reconcile?: Partial<ReconcileStatus>;
  readonly indexer?: Partial<Runtime["indexer"]>;
  readonly vectors?: Partial<Runtime["vectors"]>;
  readonly compactVectors?: Runtime["compactVectors"];
}

/**
 * A Runtime with only the pieces a route touches. Reconciler is idle by
 * default (no reconcile warnings); override `reconcile` to simulate an
 * in-flight pass.
 */
export function fakeRuntime(parts: FakeRuntimeParts = {}): Runtime {
  return {
    searcher: { search: async () => emptySearchResponse(), ...parts.searcher },
    discovery: {
      discoverProjects: () => [],
      resolveProject: () => null,
      ...parts.discovery,
    },
    state: {
      findSymbol: () => ({ defs: [], refs: [] }),
      findLiteralMatches: () => [],
      listProjects: () => [],
      // Write-path no-ops so ops/projects lifecycle routes run against
      // the fake without every test stubbing the full mutation surface.
      upsertProjectWithActive: () => undefined,
      setProjectActive: () => true,
      markProjectRebuildPending: () => undefined,
      clearProjectRebuildPending: () => undefined,
      markProjectReconciled: () => undefined,
      purgeProjectContents: () => undefined,
      deleteProject: () => undefined,
      ...parts.state,
    },
    reconciler: {
      status: () => ({ ...IDLE_RECONCILE, ...parts.reconcile }),
      reconcileAll: async () => [],
    },
    indexer: {
      indexProject: async (project: { id: string; name: string; root: string }) => ({
        project,
        indexed: 0,
        skipped: 0,
        failed: 0,
        elapsedSeconds: 0,
        failures: [],
        total: 0,
      }),
      ...parts.indexer,
    },
    vectors: {
      deleteProjectChunks: async () => undefined,
      ...parts.vectors,
    },
    compactVectors: parts.compactVectors ?? (async () => ({ beforeBytes: 0, afterBytes: 0 })),
  } as unknown as Runtime;
}

function emptySearchResponse() {
  return {
    resolvedScope: { mode: "all", project: null, relPrefix: null, inputPath: null },
    results: [],
    warnings: [],
  } as unknown as Awaited<ReturnType<Runtime["searcher"]["search"]>>;
}

/** Mount one `mount*(app, config, getRuntime)`-shaped route and return the app. */
export function appWith(
  mount: (app: Hono, config: Config, getRuntime: () => Promise<Runtime>) => void,
  config: Config,
  runtime: Runtime,
): Hono {
  const app = new Hono();
  // Same error boundary production installs (SRV-3) — routes rely on it
  // to map thrown BadRequest/Forbidden errors to their wire shape.
  registerErrorBoundary(app);
  mount(app, config, async () => runtime);
  return app;
}

/** POST a JSON body to a route and return { status, body }. */
export async function postJson(
  app: Hono,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}
