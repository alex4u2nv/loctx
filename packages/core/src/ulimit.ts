/**
 * File-descriptor budget probe.
 *
 * The watcher (@parcel/watcher) holds open-file handles per watched
 * project. On macOS the default `RLIMIT_NOFILE` is 256 (or 2560 with
 * newer defaults), which an installation with even a handful of
 * mid-sized projects burns through immediately, producing "EMFILE:
 * too many open files, watch" floods.
 *
 * This helper reads the current soft limit and reports whether it's
 * comfortable for loctx's workload. Cross-platform: uses
 * `process.getrlimit` when available (Node 24+), falls back to
 * `ulimit -n` shelled, returns null on Windows where the model
 * doesn't apply.
 */

import { execFileSync } from "node:child_process";

/** Suggested floor for fluent multi-project watching. */
export const RECOMMENDED_NOFILE = 4096;

export interface NofileStatus {
  readonly current: number;
  /** Hard ceiling — `ulimit -n` cannot raise the soft limit past it. */
  readonly hard: number;
  readonly recommended: number;
  readonly ok: boolean;
}

export interface NofileLimits {
  readonly soft: number;
  readonly hard: number;
}

function parseUlimitOutput(out: string): number | null {
  if (out === "unlimited") return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(out, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the current soft + hard RLIMIT_NOFILE. Returns null on platforms
 * where the limit doesn't apply or can't be read (Windows, restricted
 * shells).
 */
export function readNofileLimits(): NofileLimits | null {
  // Prefer the native API where it's exposed (Node 24+).
  const native = (
    process as unknown as {
      getrlimit?: (name: string) => { soft: number; hard: number };
    }
  ).getrlimit;
  if (typeof native === "function") {
    try {
      const limit = native("nofile");
      return { soft: limit.soft, hard: limit.hard };
    } catch {
      // fall through to shell
    }
  }
  if (process.platform === "win32") return null;
  try {
    const read = (flag: string): number | null =>
      parseUlimitOutput(
        execFileSync("/bin/sh", ["-c", `ulimit ${flag}`], {
          encoding: "utf-8",
          timeout: 1000,
        }).trim(),
      );
    const soft = read("-n");
    if (soft === null) return null;
    const hard = read("-Hn");
    return { soft, hard: hard ?? soft };
  } catch {
    return null;
  }
}

/** Read the current soft RLIMIT_NOFILE (see readNofileLimits). */
export function readNofile(): number | null {
  return readNofileLimits()?.soft ?? null;
}

/** Probe + classify against the recommended floor. */
export function checkNofile(recommended = RECOMMENDED_NOFILE): NofileStatus | null {
  const limits = readNofileLimits();
  if (limits === null) return null;
  return Object.freeze({
    current: limits.soft,
    hard: limits.hard,
    recommended,
    ok: limits.soft >= recommended,
  });
}

/**
 * True when the HARD limit sits below the recommended floor — the case
 * where `ulimit -n` alone cannot fix the budget (macOS launchd caps
 * the hard limit for every session; raising it takes `launchctl` and a
 * re-login).
 */
export function isHardLimitBound(status: NofileStatus): boolean {
  return Number.isFinite(status.hard) && status.hard < status.recommended;
}

/**
 * Human-readable hint shown when the limit is too low. Platform-aware:
 * when the hard limit is the binding constraint on macOS, the ulimit
 * advice alone is a dead end — the launchctl route is required first.
 * The platform/status parameters exist for tests; callers use defaults.
 */
export function nofileBumpHint(
  status: NofileStatus | null = checkNofile(),
  platform: NodeJS.Platform = process.platform,
): string {
  const lines = ["Increase the open-files limit so the filesystem watcher doesn't crash:"];
  if (platform === "darwin" && status !== null && isHardLimitBound(status)) {
    lines.push(
      `  the hard limit (${status.hard}) is below the recommended ${status.recommended},`,
      "  so `ulimit -n` alone cannot fix this:",
      "  1. sudo launchctl limit maxfiles 65536 200000",
      "  2. log out and back in (launchd applies the new cap to new sessions)",
      "  3. then: ulimit -n 10240 (or add it to ~/.zshrc)",
    );
    return lines.join("\n");
  }
  lines.push(
    "  short-term:  ulimit -n 10240",
    "  permanent:   add `ulimit -n 10240` to your ~/.zshrc or ~/.bashrc",
  );
  if (platform === "linux") {
    lines.push("  inotify watch limit (ENOSPC): sudo sysctl -w fs.inotify.max_user_watches=524288");
  }
  return lines.join("\n");
}

/**
 * Heuristic match for the error cluster that means "out of file
 * descriptors / inotify watches" — surfaced when @parcel/watcher
 * subscribe rejects. We match by string because the underlying error
 * code varies by OS:
 *   - macOS / BSD: EMFILE
 *   - Linux process-limit: EMFILE
 *   - Linux inotify-watch limit: ENOSPC (`max_user_watches`)
 *   - Some libuv frames just say "too many open files"
 *
 * Used by the watcher boot path to decide whether to print the
 * ulimit-bump hint alongside a watcher failure.
 */
export function looksLikeFdExhaustion(message: string): boolean {
  return /EMFILE|ENOSPC|too many open files|max_user_watches/i.test(message);
}
