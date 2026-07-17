/**
 * Daemon HTTP plumbing shared by the daemon-aware commands: error
 * translation, the `withDaemonClient` wrapper, the throttled index
 * progress logger, and the pause/resume scope resolver.
 */

import { DaemonHttpError, daemonClient, NoDaemonError } from "@loctx/core";
import { getCtx, loadConfigOrFail, noProjectMarkerError, resolveCommandPath } from "./context.js";

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
    process.exit(1);
  }
  if (err instanceof DaemonHttpError) {
    const body = err.body.trim();
    console.error(`[loctx] daemon ${err.status}: ${body === "" ? "(empty body)" : body}`);
    process.exit(1);
  }
  // fetch() throws a TypeError with cause.code === "ECONNREFUSED" when
  // the daemon's TCP listener dies between lockfile read and request.
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === "ECONNREFUSED") {
    console.error(
      "[loctx] daemon lockfile exists but the HTTP listener is unreachable. " +
        "The daemon may have crashed — try `loctx stop` then `loctx start`.",
    );
    process.exit(1);
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
