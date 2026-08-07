/**
 * Daemon HTTP plumbing shared by the daemon-aware commands: error
 * translation, the `withDaemonClient` wrapper, the throttled index
 * progress logger, and the pause/resume scope resolver.
 */

import {
  buildRuntime,
  buildStateRuntime,
  DaemonHttpError,
  daemonClient,
  NoDaemonError,
  type Runtime,
  readActiveDaemon,
  type StateRuntime,
} from "@loctx/core";
import {
  EXIT,
  getCtx,
  loadConfigOrFail,
  noProjectMarkerError,
  resolveCommandPath,
} from "./context.js";

/**
 * Throttled `onProgress` callback for index/rebuild passes. Emits one
 * `progress: X/Y (Z%)` line to stdout every `intervalMs` (2s default).
 * Skips the boundary samples (indexed === 0 and indexed === total) so
 * the start banner and the final summary line stay the contract.
 */
export function makeProgressLogger(
  intervalMs = 2000,
): (event: { readonly indexed: number; readonly total: number }) => void {
  let last = Date.now();
  return ({ indexed, total }) => {
    const now = Date.now();
    if (now - last >= intervalMs && indexed > 0 && indexed < total) {
      const pct = Math.floor((indexed / total) * 100);
      console.log(`  progress: ${indexed}/${total} (${pct}%)`);
      last = now;
    }
  };
}

/**
 * Translate daemon/HTTP errors to clean one-liners. Returns true when
 * the error was handled (and process.exit was called); returns false
 * when the caller should fall through to its own handling. Centralises
 * the pretty-printing so the global parseAsync catch and the explicit
 * withDaemonClient wrapper both share one rule set.
 */
export function handleDaemonError(err: unknown): boolean {
  if (err instanceof NoDaemonError) {
    console.error("No active daemon. Start one with `loctx start`.");
    process.exit(EXIT.error);
  }
  if (err instanceof DaemonHttpError) {
    const body = err.body.trim();
    console.error(`[loctx] daemon ${err.status}: ${body === "" ? "(empty body)" : body}`);
    process.exit(EXIT.error);
  }
  // fetch() throws a TypeError with cause.code === "ECONNREFUSED" when
  // the daemon's TCP listener dies between lockfile read and request.
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === "ECONNREFUSED") {
    console.error(
      "[loctx] daemon lockfile exists but the HTTP listener is unreachable. " +
        "The daemon may have crashed — try `loctx stop` then `loctx start`.",
    );
    process.exit(EXIT.error);
  }
  return false;
}

export async function withDaemonClient(
  fn: (client: ReturnType<typeof daemonClient>) => Promise<void>,
): Promise<void> {
  const ctx = getCtx();
  const config = loadConfigOrFail(ctx);
  try {
    const client = daemonClient(config.paths.dataDir);
    await fn(client);
  } catch (err) {
    handleDaemonError(err);
    throw err;
  }
}

interface WithDaemonOrLocalBase {
  /** Runs when the daemon lockfile names a live daemon. */
  readonly viaDaemon: (client: ReturnType<typeof daemonClient>) => Promise<void>;
  /**
   * Policy for a `viaDaemon` failure. Absent → the error propagates
   * (activate/rebuild/purge surface daemon errors, they don't mask
   * them). Present → it inspects the error and returns true to fall
   * back to `viaLocal` (the search commands' behavior); printing the
   * "falling back" notice — or exiting outright for a terminal case —
   * is the callback's job. Returning false propagates the error.
   */
  readonly fallbackOnError?: (err: unknown) => boolean;
}

export type WithDaemonOrLocalOptions =
  | (WithDaemonOrLocalBase & {
      /** Full runtime: embedding model + vector store (index/search work). */
      readonly localRuntime: "full";
      readonly viaLocal: (runtime: Runtime) => Promise<void>;
    })
  | (WithDaemonOrLocalBase & {
      /** State-only runtime: SQLite + discovery, no embedding warmup (#448). */
      readonly localRuntime: "state";
      readonly viaLocal: (runtime: StateRuntime) => Promise<void>;
    });

/**
 * The daemon-or-local shape shared by the six daemon-optional commands
 * (CLI-1, 2026-08-06 audit): read the daemon lock, run `viaDaemon`
 * against a live daemon, otherwise build the requested local runtime,
 * run `viaLocal`, and close the runtime in a `finally` — so callbacks
 * that set `process.exitCode` and return still release SQLite cleanly.
 * Each command's inconsistent inline copy encoded its fallback policy
 * implicitly; `fallbackOnError` makes it explicit.
 */
export async function withDaemonOrLocal(options: WithDaemonOrLocalOptions): Promise<void> {
  const config = loadConfigOrFail(getCtx());
  const lock = readActiveDaemon(config.paths.dataDir);
  if (lock !== null) {
    try {
      await options.viaDaemon(daemonClient(config.paths.dataDir));
      return;
    } catch (err) {
      if (options.fallbackOnError === undefined || !options.fallbackOnError(err)) {
        throw err;
      }
      // fall through to the local runtime
    }
  }
  if (options.localRuntime === "full") {
    const runtime = await buildRuntime(config);
    try {
      await options.viaLocal(runtime);
    } finally {
      await runtime.close();
    }
  } else {
    const runtime = buildStateRuntime(config);
    try {
      await options.viaLocal(runtime);
    } finally {
      runtime.close();
    }
  }
}

/**
 * Resolve a path/--all pair to a list of target projects for the
 * pause/resume verbs. With `--all`, asks the daemon for every active
 * watcher. Otherwise walks up from `path` (or cwd) and errors if no
 * project marker is found.
 */
export async function resolveScopedTargets(
  client: ReturnType<typeof daemonClient>,
  path: string | undefined,
  all: boolean,
  verb: string,
): Promise<Array<{ id: string; name: string }>> {
  if (all) {
    const list = await client.get<{ entries: Array<{ projectId: string; projectName: string }> }>(
      "/api/watchers",
    );
    return list.entries.map((e) => ({ id: e.projectId, name: e.projectName }));
  }
  const project = resolveCommandPath(path);
  if (project === null) {
    noProjectMarkerError(verb, path, ` Pass --all to ${verb} every project.`);
  }
  return [{ id: project.id, name: project.name }];
}
