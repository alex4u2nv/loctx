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

import { execFileSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { platform } from "node:os";
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
  // Refuse to operate on a data dir that's a symlink — a local
  // attacker writeable to `$LOCTX_DATA_DIR/..` could plant a symlink
  // here and steer the lock file (plus state DB + vectors) outside
  // the user's intended dataDir. mkdirSync above follows symlinks
  // happily; lstatSync sees the link itself. See #181.
  try {
    if (lstatSync(dataDir).isSymbolicLink()) {
      throw new Error(`refusing to use a symlinked data dir at ${dataDir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Race: dir disappeared between mkdir and lstat. Recreate and retry.
    mkdirSync(dataDir, { recursive: true });
  }
  const path = join(dataDir, LOCK_FILENAME);
  const fullInfo: DaemonInfo = { ...info, dataDir };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // O_EXCL ensures only one caller wins the create. Mode 0o600
      // restricts read access to the daemon's user (the lock file
      // carries the bound port + hostname an attacker could use to
      // shape a CSRF/rebinding probe).
      const fd = openSync(path, "wx", 0o600);
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
 * Peek at the lockfile without acquiring. Used by `loctx start` to give
 * users visibility when a previous daemon left a stale lockfile behind
 * (e.g. killed with SIGKILL, OS crash). Returns `{ kind: "stale", info }`
 * when the file exists but the recorded PID is no longer running —
 * acquireDaemonLock will reclaim it silently otherwise.
 */
export type LockfileStatus =
  | { readonly kind: "absent" }
  | { readonly kind: "active"; readonly info: DaemonInfo }
  | { readonly kind: "stale"; readonly info: DaemonInfo }
  | { readonly kind: "corrupt" };

export function inspectDaemonLockfile(dataDir: string): LockfileStatus {
  const path = join(dataDir, LOCK_FILENAME);
  const info = readDaemonInfoFromPath(path);
  if (info === null) {
    // File may be missing OR garbled. Distinguish so callers can tell
    // "fresh start" from "previous daemon wrote junk."
    try {
      readFileSync(path, "utf-8");
      return { kind: "corrupt" };
    } catch {
      return { kind: "absent" };
    }
  }
  return isProcessAlive(info.pid) ? { kind: "active", info } : { kind: "stale", info };
}

/**
 * Send SIGTERM to the daemon if one is running for ``dataDir``, then poll
 * until the lock file disappears (the daemon's signal handler removes it
 * before exit). Returns the info of the terminated daemon, or null if
 * nothing was running.
 */
export class LockFileTamperedError extends Error {
  constructor(
    readonly pid: number,
    readonly command: string,
  ) {
    super(
      `refusing to signal PID ${pid}: command line "${command}" doesn't look like a loctx daemon — the lock file may have been tampered with`,
    );
    this.name = "LockFileTamperedError";
  }
}

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

  // Integrity gate: verify the lockfile's PID still points at something
  // that looks like a loctx process before signaling it. A hostile
  // local actor with write access to the data dir could otherwise
  // redirect `loctx stop` to kill any user-owned PID (browser, editor,
  // ssh-agent). On platforms where the verification fails for benign
  // reasons (missing `ps`) we skip the check rather than break stop.
  const verification = verifyLoctxProcess(info.pid);
  if (verification.outcome === "not-loctx") {
    throw new LockFileTamperedError(info.pid, verification.command);
  }

  // PID-reuse guard: between `verifyLoctxProcess` and `process.kill`
  // the original daemon could exit and the OS could recycle its PID
  // to a new process. Re-read the lock file immediately before
  // signaling — if it still names the same PID, the daemon is still
  // running under that PID and SIGTERM is safe; otherwise abort.
  // See #182.
  const stillRecorded = readDaemonInfoFromPath(path);
  if (stillRecorded === null || stillRecorded.pid !== info.pid) {
    // Lock file changed underneath us; treat as "daemon already gone".
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

type ProcessVerification =
  | { outcome: "loctx"; command: string }
  | { outcome: "not-loctx"; command: string }
  | { outcome: "unknown"; reason: string };

/**
 * Check whether `pid` looks like a running loctx process. POSIX-only
 * (uses `ps -p`); on Windows or platforms without `ps` we return
 * `unknown` and callers proceed as before — the integrity gate is a
 * best-effort defence, not a hard guarantee.
 */
function verifyLoctxProcess(pid: number): ProcessVerification {
  if (platform() === "win32") {
    return { outcome: "unknown", reason: "ps not available on win32" };
  }
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (cmd === "") return { outcome: "unknown", reason: "ps returned no command" };
    if (looksLikeLoctxCommand(cmd)) return { outcome: "loctx", command: cmd };
    return { outcome: "not-loctx", command: cmd };
  } catch (err) {
    return { outcome: "unknown", reason: (err as Error).message };
  }
}

function looksLikeLoctxCommand(cmd: string): boolean {
  // Daemon command lines we expect:
  //   `node .../apps/cli/dist/cli.js start ...`     (workspace run)
  //   `node .../node_modules/.bin/loctx start ...`  (installed)
  //   `loctx start ...`                              (PATH-resolved bin)
  //   `node .../dist/cli.js start ...`              (linked)
  return /\bloctx\b/.test(cmd) || /\/dist\/cli\.js/.test(cmd);
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
