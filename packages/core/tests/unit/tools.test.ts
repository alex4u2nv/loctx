/**
 * Analyzer installer (tools.ts) — path/command construction and the
 * error branches, exercised with mocked subprocess + fetch so no venv
 * is created, no binary downloaded, and no network hit (#470).
 */

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { installTool, managedToolCommand, TOOL_NAMES } from "../../src/tools.js";

// execFile always fails → findPython() returns null and any subprocess
// (venv/pip/unzip) errors, so no real process ever runs.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (_cmd: string, _args: unknown, opts: unknown, cb: unknown) => {
      const callback = (typeof opts === "function" ? opts : cb) as ((e: Error) => void) | undefined;
      callback?.(new Error("mocked: command not found"));
    },
  };
});

function fakeConfig(dataDir: string): Config {
  return {
    paths: { dataDir },
    network: { proxy: null, caCert: null },
  } as unknown as Config;
}

afterEach(() => vi.unstubAllGlobals());

describe("managedToolCommand path construction", () => {
  const cfg = fakeConfig("/data");

  it("puts pip tools under the managed venv bin", () => {
    // (posix expectations; the suite runs on macOS/Linux CI)
    expect(managedToolCommand(cfg, "lizard")).toBe(join("/data", "tools", "venv", "bin", "lizard"));
    expect(managedToolCommand(cfg, "semgrep")).toBe(
      join("/data", "tools", "venv", "bin", "semgrep"),
    );
  });

  it("puts ast-grep under tools/bin", () => {
    expect(managedToolCommand(cfg, "ast-grep")).toBe(join("/data", "tools", "bin", "ast-grep"));
  });

  it("TOOL_NAMES lists the three optional analyzers", () => {
    expect([...TOOL_NAMES].sort()).toEqual(["ast-grep", "lizard", "semgrep"]);
  });
});

describe("installTool error branches", () => {
  it("reports a clear error when python is missing (pip tools)", async () => {
    const r = await installTool(fakeConfig("/tmp/loctx-tools-x"), "lizard");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/python3 not found/i);
  });

  it("surfaces a GitHub release-lookup failure for ast-grep (no download)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" })),
    );
    const r = await installTool(fakeConfig("/tmp/loctx-tools-y"), "ast-grep");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Either "no prebuilt for <platform>" on an unsupported arch, or the
    // 503 from the mocked release lookup — both are correct error paths.
    expect(r.error).toMatch(/GitHub returned 503|no ast-grep prebuilt/);
  });
});
