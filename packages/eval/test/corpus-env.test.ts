/**
 * Sandbox env hygiene (#466). buildSandboxedRuntime overrides
 * LOCTX_EMBEDDING_PROVIDER / LOCTX_DATA_DIR / LOCTX_CONFIG_DIR and must
 * restore them on close(). The bug: restoring an originally-unset var
 * by assigning `undefined` coerces to the string "undefined" and keeps
 * the key, poisoning the next loadConfig() in the same process.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildSandboxedRuntime } from "../src/corpus.js";
import type { CorpusConfig } from "../src/types.js";

const KEYS = ["LOCTX_EMBEDDING_PROVIDER", "LOCTX_DATA_DIR", "LOCTX_CONFIG_DIR"] as const;

const corpus: CorpusConfig = {
  name: "env-test",
  repo: "unused",
  sha: "0000000000000000000000000000000000000000",
  indexConfig: "default",
};

const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("buildSandboxedRuntime env restore (#466)", () => {
  it("deletes originally-unset vars on close instead of writing the string 'undefined'", async () => {
    for (const k of KEYS) delete process.env[k];

    const sandbox = await buildSandboxedRuntime(corpus);
    expect(process.env["LOCTX_EMBEDDING_PROVIDER"]).toBe("fake");
    expect(process.env["LOCTX_DATA_DIR"]).toBe(sandbox.dataDir);
    await sandbox.close();

    for (const k of KEYS) {
      expect(k in process.env, `${k} should be absent after close()`).toBe(false);
      expect(process.env[k]).not.toBe("undefined");
    }
  });

  it("restores originally-set vars to their prior values", async () => {
    process.env["LOCTX_EMBEDDING_PROVIDER"] = "prior-provider";
    process.env["LOCTX_DATA_DIR"] = "/prior/data";
    delete process.env["LOCTX_CONFIG_DIR"];

    const sandbox = await buildSandboxedRuntime(corpus);
    await sandbox.close();

    expect(process.env["LOCTX_EMBEDDING_PROVIDER"]).toBe("prior-provider");
    expect(process.env["LOCTX_DATA_DIR"]).toBe("/prior/data");
    expect("LOCTX_CONFIG_DIR" in process.env).toBe(false);
  });
});
