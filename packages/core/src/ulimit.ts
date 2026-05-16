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

import { execFileSync } from "node:child_process";

/** Suggested floor for fluent multi-project watching. */
export const RECOMMENDED_NOFILE = 4096;

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
    "Increase the open-files limit so the filesystem watcher doesn't crash:",
    "  short-term:  ulimit -n 10240",
    "  permanent:   add `ulimit -n 10240` to your ~/.zshrc or ~/.bashrc",
  ].join("\n");
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
