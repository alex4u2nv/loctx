/**
 * runDoctorChecks + worstStatus (#470). Drives the diagnostics against a
 * hermetic tmp-path config and asserts the status each check produces.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { type DoctorCheck, runDoctorChecks, worstStatus } from "../../src/doctor.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let savedData: string | undefined;
let savedCfg: string | undefined;

beforeEach(() => {
  tmp = mkTmpDir();
  savedData = process.env["LOCTX_DATA_DIR"];
  savedCfg = process.env["LOCTX_CONFIG_DIR"];
  process.env["LOCTX_DATA_DIR"] = join(tmp, "data");
  process.env["LOCTX_CONFIG_DIR"] = join(tmp, "cfg");
});
afterEach(() => {
  if (savedData === undefined) delete process.env["LOCTX_DATA_DIR"];
  else process.env["LOCTX_DATA_DIR"] = savedData;
  if (savedCfg === undefined) delete process.env["LOCTX_CONFIG_DIR"];
  else process.env["LOCTX_CONFIG_DIR"] = savedCfg;
  rmTmpDir(tmp);
});

function byName(checks: ReadonlyArray<DoctorCheck>, name: string): DoctorCheck | undefined {
  return checks.find((c) => c.name === name);
}

describe("runDoctorChecks (#470)", () => {
  it("reports config ok, daemon not-running as a warning, and absent state DB as a warning", async () => {
    const config = loadConfig();
    const checks = await runDoctorChecks(config);

    expect(byName(checks, "config")?.status).toBe("ok");
    expect(byName(checks, "daemon")?.status).toBe("warn");
    expect(byName(checks, "daemon")?.detail).toMatch(/not running/);
    expect(byName(checks, "state.sqlite3")?.status).toBe("warn");
  });

  it("marks an existing dir ok and a missing dir as a warning", async () => {
    const config = loadConfig(); // ensurePaths created every storage dir
    // Remove one so the "will be created on first use" branch fires.
    rmSync(config.paths.vectorDir, { recursive: true, force: true });
    const checks = await runDoctorChecks(config);
    expect(byName(checks, "path:dataDir")?.status).toBe("ok");
    expect(byName(checks, "path:vectorDir")?.status).toBe("warn");
    expect(byName(checks, "path:vectorDir")?.detail).toMatch(/will be created/);
  });

  it("errors when a path that should be a directory is a file", async () => {
    const config = loadConfig();
    // Replace the logs dir with a regular file.
    rmSync(config.paths.logsDir, { recursive: true, force: true });
    writeFileSync(config.paths.logsDir, "not a dir");
    const checks = await runDoctorChecks(config);
    expect(byName(checks, "path:logsDir")?.status).toBe("error");
    expect(byName(checks, "path:logsDir")?.detail).toMatch(/not a directory/);
  });
});

describe("worstStatus", () => {
  const mk = (status: DoctorCheck["status"]): DoctorCheck => ({ name: "x", status, detail: "" });

  it("returns ok when every check is ok", () => {
    expect(worstStatus([mk("ok"), mk("ok")])).toBe("ok");
  });

  it("escalates to warn on any warning", () => {
    expect(worstStatus([mk("ok"), mk("warn"), mk("ok")])).toBe("warn");
  });

  it("escalates to error when any check errors, regardless of order", () => {
    expect(worstStatus([mk("warn"), mk("error"), mk("ok")])).toBe("error");
    expect(worstStatus([mk("error")])).toBe("error");
  });

  it("returns ok for an empty check list", () => {
    expect(worstStatus([])).toBe("ok");
  });
});
