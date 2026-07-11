import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildStateRuntime } from "../../src/container.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let configPath: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  tmp = mkTmpDir();
  configPath = join(tmp, "config.yaml");
  // Storage paths come from env, not YAML — point the state DB at the
  // tmp dir so the test never opens the developer's real index.
  savedDataDir = process.env["LOCTX_DATA_DIR"];
  process.env["LOCTX_DATA_DIR"] = join(tmp, "data");
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env["LOCTX_DATA_DIR"];
  else process.env["LOCTX_DATA_DIR"] = savedDataDir;
  rmTmpDir(tmp);
});

function writeConfig(): void {
  const workspace = join(tmp, "ws");
  mkdirSync(join(workspace, "alpha", ".git"), { recursive: true });
  writeFileSync(configPath, `workspace_roots:\n  - ${workspace}\n`, "utf-8");
}

describe("buildStateRuntime (#448)", () => {
  it("provides state + discovery without an embedding provider", () => {
    writeConfig();
    const config = loadConfig({ configPath });
    // The default embedding provider is the local ONNX model, whose
    // warmup gates on network consent and costs seconds. buildRuntime
    // pays that unconditionally; buildStateRuntime must not — this
    // construction succeeding synchronously IS the assertion, since a
    // local-provider warmup would throw on the outbound-network gate
    // in this hermetic test environment.
    const runtime = buildStateRuntime(config);
    try {
      expect(config.embedding.provider ?? "local").not.toBe("fake");
      expect(runtime.discovery.discoverProjects().map((p) => p.name)).toEqual(["alpha"]);
      expect(runtime.state.listProjects()).toEqual([]);
      expect(runtime.config).toBe(config);
    } finally {
      runtime.close();
    }
  });

  it("close() releases the SQLite handle", () => {
    writeConfig();
    const runtime = buildStateRuntime(loadConfig({ configPath }));
    runtime.close();
    expect(() => runtime.state.listProjects()).toThrow();
  });
});
