/**
 * File-descriptor budget probe.
 *
 * Chokidar opens roughly 1-2 file descriptors per watched directory.
 * On macOS the default `RLIMIT_NOFILE` is 256 (or 2560 with newer
 * defaults), which an installation with even a handful of mid-sized
 * projects burns through immediately, producing "EMFILE: too many
 * open files, watch" floods.
 *
 * This helper reads the current soft limit and reports whether it's
 * comfortable for loctx's workload. Cross-platform: uses
 * `process.getrlimit` when available (Node 24+), falls back to
 * `ulimit -n` shelled, returns null on Windows where the model
 * doesn't apply.
 */

import { execFileSync, spawnSync } from "node:child_process";

/** Marker env var: set when the current process is the post-respawn child. */
export const NOFILE_RESPAWN_ENV = "LOCTX_NOFILE_RAISED";

/**
 * Suggested floor for fluent multi-project watching. 10240 matches the
 * `ulimit -n 10240` that macOS users typically set in `~/.zshrc`. 4096
 * was too tight in practice — workspaces with 15-20 projects, each
 * with deep trees, blow through it during chokidar's initial scan.
 */
export const RECOMMENDED_NOFILE = 10240;

export interface NofileStatus {
  readonly current: number;
  readonly recommended: number;
  readonly ok: boolean;
}

/**
 * Read the current soft RLIMIT_NOFILE. Returns null on platforms where
 * the limit doesn't apply or can't be read (Windows, restricted shells).
 */
export function readNofile(): number | null {
  // Prefer the native API where it's exposed (Node 24+).
  const native = (
    process as unknown as {
      getrlimit?: (name: string) => { soft: number; hard: number };
    }
  ).getrlimit;
  if (typeof native === "function") {
    try {
      const limit = native("nofile");
      return limit.soft;
    } catch {
      // fall through to shell
    }
  }
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("/bin/sh", ["-c", "ulimit -n"], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    if (out === "unlimited") return Number.POSITIVE_INFINITY;
    const parsed = Number.parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Probe + classify against the recommended floor. */
export function checkNofile(recommended = RECOMMENDED_NOFILE): NofileStatus | null {
  const current = readNofile();
  if (current === null) return null;
  return Object.freeze({
    current,
    recommended,
    ok: current >= recommended,
  });
}

/** Human-readable hint shown when the limit is too low. */
export function nofileBumpHint(): string {
  return [
    `Increase the open-files limit so the filesystem watcher doesn't crash:`,
    `  short-term:  ulimit -n ${RECOMMENDED_NOFILE}`,
    `  permanent:   add \`ulimit -n ${RECOMMENDED_NOFILE}\` to your ~/.zshrc or ~/.bashrc`,
  ].join("\n");
}

/**
 * Re-exec the current Node process under a shell that has `ulimit -n`
 * raised. Required because Node 25 doesn't expose `process.setrlimit`,
 * so we can't bump our own RLIMIT_NOFILE in-process. The shell sets
 * `ulimit -n <target>` then `exec`s us back, so the new Node inherits
 * the higher soft limit. The {@link NOFILE_RESPAWN_ENV} marker prevents
 * an infinite respawn loop.
 *
 * Skips when:
 *   - already respawned (env marker set)
 *   - platform is Windows (no `ulimit`)
 *   - current limit is already at or above `target`
 *   - shell is unavailable
 *
 * If respawn succeeds the parent process exits with the child's status
 * and this function never returns. If we return, no respawn happened —
 * caller continues normally (and probably warns).
 */
export function maybeRespawnWithRaisedNofile(target = RECOMMENDED_NOFILE): void {
  if (process.env[NOFILE_RESPAWN_ENV] === "1") return;
  if (process.platform === "win32") return;
  const current = readNofile();
  if (current === null) return;
  if (current >= target) return;

  // Re-invoke ourselves through `/bin/sh -c "ulimit -n <T> && exec node <cli> ..."`.
  // argv[0] is the node binary; argv[1..] is the script + user args.
  const argv = [process.execPath, ...process.argv.slice(1)];
  const quoted = argv.map(shellQuote).join(" ");
  const cmd = `ulimit -n ${target} 2>/dev/null; exec ${quoted}`;
  console.error(
    `[loctx start] open-files limit is ${current}; respawning under shell with ulimit -n ${target}`,
  );
  try {
    const result = spawnSync("/bin/sh", ["-c", cmd], {
      stdio: "inherit",
      env: { ...process.env, [NOFILE_RESPAWN_ENV]: "1" },
    });
    process.exit(result.status ?? 0);
  } catch {
    // Shell unavailable or spawn failed; let the caller continue and
    // surface the regular warning instead.
  }
}

function shellQuote(arg: string): string {
  // Single-quote everything; replace embedded ' with '\''.
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export interface RaiseResult {
  /** Soft limit before our call. */
  readonly previousSoft: number;
  /** Soft limit after our call (may equal previous if unchanged or capped). */
  readonly newSoft: number;
  /** Hard limit (the ceiling we couldn't exceed without root). */
  readonly hard: number;
  /** True when newSoft >= target. */
  readonly satisfied: boolean;
}

/**
 * Try to raise the soft RLIMIT_NOFILE up to `target`, capped at the
 * existing hard limit. No-ops on platforms without `process.setrlimit`
 * (Node < 24, Windows). Process-local — does not affect the parent
 * shell or other processes. Safe to call repeatedly.
 *
 * Strategy:
 *   - If soft already >= target: nothing to do.
 *   - If hard >= target: raise soft to target.
 *   - Else: raise soft to hard (best effort; caller still warns).
 *
 * Returns null when neither getrlimit nor setrlimit is available.
 */
export function raiseNofile(target = RECOMMENDED_NOFILE): RaiseResult | null {
  const proc = process as unknown as {
    getrlimit?: (name: string) => { soft: number; hard: number };
    setrlimit?: (name: string, limits: { soft: number; hard: number }) => void;
  };
  if (typeof proc.getrlimit !== "function" || typeof proc.setrlimit !== "function") {
    return null;
  }
  let limits: { soft: number; hard: number };
  try {
    limits = proc.getrlimit("nofile");
  } catch {
    return null;
  }
  const desired = Math.min(target, limits.hard);
  if (limits.soft >= desired) {
    return Object.freeze({
      previousSoft: limits.soft,
      newSoft: limits.soft,
      hard: limits.hard,
      satisfied: limits.soft >= target,
    });
  }
  try {
    proc.setrlimit("nofile", { soft: desired, hard: limits.hard });
  } catch {
    // Setting failed (e.g. sandboxed); report as unchanged so caller
    // can still warn.
    return Object.freeze({
      previousSoft: limits.soft,
      newSoft: limits.soft,
      hard: limits.hard,
      satisfied: false,
    });
  }
  return Object.freeze({
    previousSoft: limits.soft,
    newSoft: desired,
    hard: limits.hard,
    satisfied: desired >= target,
  });
}
