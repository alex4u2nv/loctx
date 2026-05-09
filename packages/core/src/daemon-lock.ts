/**
 * Single-instance daemon lock keyed on the data dir.
 *
 * Two `loctx start` daemons sharing the same `$LOCTX_DATA_DIR` would race
 * on SQLite writes and corrupt the LanceDB index, so we enforce one at a
 * time via a PID file at `<dataDir>/loctx.pid`. The lock is keyed on the
 * data dir (not the install path), so the rule holds whether loctx was
 * launched from the monorepo, an `npm link`-ed install, or
 * `npm install -g loctx`.
 *
 * Stale-lock recovery: if the PID in the file points to a dead process,
 * the file is reclaimed automatically.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const LOCK_FILENAME = "loctx.pid";

export interface DaemonInfo {
  readonly pid: number;
  readonly port?: number;
  readonly hostname?: string;
  readonly startedAt: string; // ISO-8601
  readonly version: string;
  readonly dataDir: string;
}

export interface DaemonLock {
  readonly info: DaemonInfo;
  readonly path: string;
  release(): void;
}

export class DaemonLockHeldError extends Error {
  constructor(public readonly holder: DaemonInfo) {
    super(
      `another loctx daemon is already running for this data dir (PID ${holder.pid}, started ${holder.startedAt}${holder.port ? `, port ${holder.port}` : ""}). Use \`loctx stop\` or \`loctx restart\`.`,
    );
    this.name = "DaemonLockHeldError";
  }
}

/**
 * Atomically claim the daemon lock for ``dataDir``.
 *
 * Throws {@link DaemonLockHeldError} when another live process holds it.
 * Stale locks (PID dead) are reclaimed silently.
 */
export function acquireDaemonLock(dataDir: string, info: Omit<DaemonInfo, "dataDir">): DaemonLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILENAME);
  const fullInfo: DaemonInfo = { ...info, dataDir };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify(fullInfo, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { info: fullInfo, path, release: () => releaseLockFile(path, fullInfo.pid) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readDaemonInfoFromPath(path);
      if (existing === null) {
        // Garbled / unreadable lock file. Assume orphan and try to recover.
        rmSync(path, { force: true });
        continue;
      }
      if (isProcessAlive(existing.pid)) {
        throw new DaemonLockHeldError(existing);
      }
      // Stale PID — clear and retry.
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not acquire daemon lock at ${path} after 3 attempts.`);
}

/** Read a daemon's recorded info if it currently holds the lock and is alive. */
export function readActiveDaemon(dataDir: string): DaemonInfo | null {
  const info = readDaemonInfoFromPath(join(dataDir, LOCK_FILENAME));
  if (info === null) return null;
  return isProcessAlive(info.pid) ? info : null;
}

/**
 * Send SIGTERM to the daemon if one is running for ``dataDir``, then poll
 * until the lock file disappears (the daemon's signal handler removes it
 * before exit). Returns the info of the terminated daemon, or null if
 * nothing was running.
 */
export async function stopActiveDaemon(
  dataDir: string,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<DaemonInfo | null> {
  const path = join(dataDir, LOCK_FILENAME);
  const info = readDaemonInfoFromPath(path);
  if (info === null || !isProcessAlive(info.pid)) {
    rmSync(path, { force: true });
    return null;
  }

  process.kill(info.pid, "SIGTERM");

  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  const pollMs = options.pollMs ?? 150;
  while (Date.now() < deadline) {
    if (!isProcessAlive(info.pid)) {
      rmSync(path, { force: true });
      return info;
    }
    await sleep(pollMs);
  }

  // Last resort: SIGKILL and clean up.
  try {
    process.kill(info.pid, "SIGKILL");
  } catch {
    // already gone
  }
  rmSync(path, { force: true });
  return info;
}

// ---- helpers -----------------------------------------------------------

function readDaemonInfoFromPath(path: string): DaemonInfo | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DaemonInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return parsed as DaemonInfo;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 → "is this PID a real process I'm allowed to signal?"
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseLockFile(path: string, expectedPid: number): void {
  // Only unlink if the file still belongs to us — protects against the rare
  // case where another daemon has already replaced our entry.
  const info = readDaemonInfoFromPath(path);
  if (info === null || info.pid === expectedPid) {
    rmSync(path, { force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export the shape of the lock file path so callers can mention it in
// error messages without hard-coding the filename in two places.
export function daemonLockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILENAME);
}
