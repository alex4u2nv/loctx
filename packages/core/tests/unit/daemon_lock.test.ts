import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DaemonLockHeldError,
  LockFileTamperedError,
  acquireDaemonLock,
  daemonLockPath,
  readActiveDaemon,
  stopActiveDaemon,
} from "../../src/daemon-lock.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
beforeEach(() => {
  tmp = mkTmpDir();
});
afterEach(() => {
  rmTmpDir(tmp);
});

function info(pid: number = process.pid) {
  return {
    pid,
    port: 3000,
    hostname: "localhost",
    startedAt: new Date().toISOString(),
    version: "0.0.0-test",
  };
}

describe("acquireDaemonLock", () => {
  it("writes a lock file with the daemon info", () => {
    const lock = acquireDaemonLock(tmp, info());
    try {
      expect(existsSync(lock.path)).toBe(true);
      expect(lock.path).toBe(daemonLockPath(tmp));
      const parsed = JSON.parse(readFileSync(lock.path, "utf-8"));
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.dataDir).toBe(tmp);
    } finally {
      lock.release();
    }
    expect(existsSync(daemonLockPath(tmp))).toBe(false);
  });

  it("rejects a second concurrent acquire from the same dataDir", () => {
    const first = acquireDaemonLock(tmp, info());
    try {
      // Use a real-but-foreign live PID (the test runner itself) so the
      // freshness check can't reclaim it as stale. Re-using process.pid
      // simulates two daemons fighting for the same data dir.
      expect(() => acquireDaemonLock(tmp, info())).toThrow(DaemonLockHeldError);
    } finally {
      first.release();
    }
  });

  it("reclaims a stale lock whose PID is dead", () => {
    // Forge a lock file pointing at a guaranteed-dead PID.
    const stale = {
      pid: 99_999_999,
      port: 1234,
      hostname: "localhost",
      startedAt: new Date(0).toISOString(),
      version: "0.0.0-stale",
      dataDir: tmp,
    };
    writeFileSync(daemonLockPath(tmp), JSON.stringify(stale));
    const lock = acquireDaemonLock(tmp, info());
    try {
      const parsed = JSON.parse(readFileSync(lock.path, "utf-8"));
      expect(parsed.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("reclaims a garbled lock file", () => {
    writeFileSync(daemonLockPath(tmp), "not valid json");
    const lock = acquireDaemonLock(tmp, info());
    try {
      expect(JSON.parse(readFileSync(lock.path, "utf-8")).pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("simulates crash-then-restart: stale lock with dead PID is reclaimed end-to-end (#165)", () => {
    // Phase 1: a "daemon" has crashed leaving a real-looking lock file
    // on disk. We model the crash by forging a lock pointing at a
    // dead PID — same shape as the lock file written by a real
    // daemon, including the dataDir field acquireDaemonLock stamps.
    const crashedDaemon = {
      pid: 99_999_999,
      port: 3022,
      hostname: "127.0.0.1",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      version: "0.0.0-crashed",
      dataDir: tmp,
    };
    writeFileSync(daemonLockPath(tmp), JSON.stringify(crashedDaemon));
    expect(existsSync(daemonLockPath(tmp))).toBe(true);
    // The readActiveDaemon path treats a dead-PID lock as "no daemon"
    // — important because daemon-client uses this to decide whether
    // to talk to the daemon vs run the work locally.
    expect(readActiveDaemon(tmp)).toBeNull();

    // Phase 2: a fresh daemon starts. It must reclaim cleanly — no
    // DaemonLockHeldError, no manual cleanup required.
    const fresh = acquireDaemonLock(tmp, info());
    try {
      const onDisk = JSON.parse(readFileSync(fresh.path, "utf-8"));
      expect(onDisk.pid).toBe(process.pid);
      expect(onDisk.version).toBe("0.0.0-test");
      // And readActiveDaemon now sees the fresh daemon by its live
      // PID, so daemon-client routes through it.
      const active = readActiveDaemon(tmp);
      expect(active?.pid).toBe(process.pid);
    } finally {
      fresh.release();
    }
  });
});

describe("readActiveDaemon", () => {
  it("returns null when no lock file exists", () => {
    expect(readActiveDaemon(tmp)).toBeNull();
  });

  it("returns daemon info while the lock is held", () => {
    const lock = acquireDaemonLock(tmp, info());
    try {
      const active = readActiveDaemon(tmp);
      expect(active?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("returns null when the lock points at a dead PID", () => {
    writeFileSync(
      daemonLockPath(tmp),
      JSON.stringify({
        pid: 99_999_999,
        startedAt: new Date().toISOString(),
        version: "stale",
        dataDir: tmp,
      }),
    );
    expect(readActiveDaemon(tmp)).toBeNull();
  });
});

describe("stopActiveDaemon", () => {
  it("returns null and clears stale files when nothing is running", async () => {
    writeFileSync(
      daemonLockPath(tmp),
      JSON.stringify({
        pid: 99_999_999,
        startedAt: new Date().toISOString(),
        version: "stale",
        dataDir: tmp,
      }),
    );
    const result = await stopActiveDaemon(tmp);
    expect(result).toBeNull();
    expect(existsSync(daemonLockPath(tmp))).toBe(false);
  });

  it("returns null when no lock file is present", async () => {
    expect(await stopActiveDaemon(tmp)).toBeNull();
  });

  it("refuses to signal a live PID whose command line isn't a loctx process", async () => {
    // Point the lockfile at our own test-runner PID — its command line
    // is `node /…/vitest-worker.js` (or similar), which does not match
    // the loctx pattern. The integrity gate should refuse to signal.
    writeFileSync(
      daemonLockPath(tmp),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        version: "tampered",
        dataDir: tmp,
      }),
    );
    await expect(stopActiveDaemon(tmp)).rejects.toBeInstanceOf(LockFileTamperedError);
    // Lockfile is intentionally NOT cleaned up — the user should see
    // the file and investigate. (Stale-PID path still cleans up; this
    // is the live-but-suspect path.)
  });
});
