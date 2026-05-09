import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DaemonLockHeldError,
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
});
