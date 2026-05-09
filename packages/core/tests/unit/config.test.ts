import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkTmpDir();
  configPath = join(tmp, "global.yaml");
});

afterEach(() => {
  rmTmpDir(tmp);
});

describe("loadConfig precedence chain", () => {
  it("returns built-in defaults when neither file is present", () => {
    const config = loadConfig({ configPath, cwd: tmp });
    expect(config.embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(config.daemon.port).toBe(3000);
    expect(config.daemon.hostname).toBe("localhost");
    expect(config.watcher.debounceMs).toBe(500);
    expect(config.source).toBeNull();
    expect(config.projectSource).toBeNull();
    expect(config.sources["embedding.model"]).toBe("default");
    expect(config.sources["daemon.port"]).toBe("default");
  });

  it("global file overrides defaults", () => {
    writeFileSync(configPath, "daemon:\n  port: 4000\nembedding:\n  model: my-model\n", "utf-8");
    const config = loadConfig({ configPath, cwd: tmp });
    expect(config.daemon.port).toBe(4000);
    expect(config.embedding.model).toBe("my-model");
    expect(config.source).toBe(configPath);
    expect(config.sources["daemon.port"]).toBe("global");
    expect(config.sources["embedding.model"]).toBe("global");
    // Defaults still apply for unset keys.
    expect(config.daemon.hostname).toBe("localhost");
    expect(config.sources["daemon.hostname"]).toBe("default");
  });

  it("project .loctx.yaml overrides the global file", () => {
    writeFileSync(configPath, "daemon:\n  port: 4000\n", "utf-8");
    writeFileSync(join(tmp, ".loctx.yaml"), "daemon:\n  port: 5050\n", "utf-8");
    const config = loadConfig({ configPath, cwd: tmp });
    expect(config.daemon.port).toBe(5050);
    expect(config.projectSource).toBe(join(tmp, ".loctx.yaml"));
    expect(config.sources["daemon.port"]).toBe("project");
  });

  it("walks up parent directories to find .loctx.yaml", () => {
    writeFileSync(join(tmp, ".loctx.yaml"), "daemon:\n  port: 9001\n", "utf-8");
    const nested = join(tmp, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const config = loadConfig({ configPath, cwd: nested });
    expect(config.daemon.port).toBe(9001);
    expect(config.projectSource).toBe(join(tmp, ".loctx.yaml"));
  });

  it("merges per-leaf: project sets one key, global another", () => {
    writeFileSync(configPath, "embedding:\n  model: from-global\n", "utf-8");
    writeFileSync(join(tmp, ".loctx.yaml"), "daemon:\n  port: 7777\n", "utf-8");
    const config = loadConfig({ configPath, cwd: tmp });
    expect(config.embedding.model).toBe("from-global");
    expect(config.daemon.port).toBe(7777);
    expect(config.sources["embedding.model"]).toBe("global");
    expect(config.sources["daemon.port"]).toBe("project");
  });

  it("rejects legacy `filtering` section in either file", () => {
    writeFileSync(configPath, "filtering:\n  skip: true\n", "utf-8");
    expect(() => loadConfig({ configPath, cwd: tmp })).toThrow(ConfigError);
  });

  it("rejects malformed YAML", () => {
    writeFileSync(configPath, "this: is: not: valid: yaml: [\n", "utf-8");
    expect(() => loadConfig({ configPath, cwd: tmp })).toThrow(ConfigError);
  });

  it("rejects non-mapping top-level YAML", () => {
    writeFileSync(configPath, "- 1\n- 2\n", "utf-8");
    expect(() => loadConfig({ configPath, cwd: tmp })).toThrow(ConfigError);
  });

  it("flags paths source as 'env' when LOCTX_DATA_DIR is set", () => {
    const prev = process.env["LOCTX_DATA_DIR"];
    process.env["LOCTX_DATA_DIR"] = join(tmp, "alt-data");
    try {
      const config = loadConfig({ configPath, cwd: tmp });
      expect(config.sources["paths.dataDir"]).toBe("env");
    } finally {
      // Reflect.deleteProperty: same effect as `delete process.env[k]` but
      // satisfies biome's noDelete rule (whose unsafe fix would set the var
      // to the string "undefined", which is not what we want).
      if (prev === undefined) Reflect.deleteProperty(process.env, "LOCTX_DATA_DIR");
      else process.env["LOCTX_DATA_DIR"] = prev;
    }
  });

  it("surfaces LOCTX_EMBEDDING_PROVIDER as embedding.providerOverride", () => {
    const prev = process.env["LOCTX_EMBEDDING_PROVIDER"];
    process.env["LOCTX_EMBEDDING_PROVIDER"] = "fake";
    try {
      const config = loadConfig({ configPath, cwd: tmp });
      expect(config.embedding.providerOverride).toBe("fake");
      expect(config.sources["embedding.providerOverride"]).toBe("env");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "LOCTX_EMBEDDING_PROVIDER");
      else process.env["LOCTX_EMBEDDING_PROVIDER"] = prev;
    }
  });

  it("omits providerOverride when LOCTX_EMBEDDING_PROVIDER is unset", () => {
    const prev = process.env["LOCTX_EMBEDDING_PROVIDER"];
    Reflect.deleteProperty(process.env, "LOCTX_EMBEDDING_PROVIDER");
    try {
      const config = loadConfig({ configPath, cwd: tmp });
      expect(config.embedding.providerOverride).toBeUndefined();
      expect(config.sources["embedding.providerOverride"]).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env["LOCTX_EMBEDDING_PROVIDER"] = prev;
    }
  });
});
