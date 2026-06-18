import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, summarizeLegacyProjectConfig } from "../../src/config.js";
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
  it("returns built-in defaults when no global file is present", () => {
    const config = loadConfig({ configPath });
    expect(config.embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(config.daemon.port).toBe(3022);
    expect(config.daemon.hostname).toBe("127.0.0.1");
    expect(config.watcher.debounceMs).toBe(500);
    expect(config.source).toBeNull();
    expect(config.sources["embedding.model"]).toBe("default");
    expect(config.sources["daemon.port"]).toBe("default");
  });

  it("ships every analyzer enabled by default so the tool is useful out of the box", () => {
    const config = loadConfig({ configPath });
    expect(config.analyzers.backgroundEnabled).toBe(true);
    expect(config.analyzers.duplicates.enabled).toBe(true);
    expect(config.analyzers.lizard.enabled).toBe(true);
    expect(config.analyzers.semgrep.enabled).toBe(true);
    expect(config.analyzers.astGrep.enabled).toBe(true);
  });

  it("network defaults to direct + strict TLS (no proxy, no CA)", () => {
    const config = loadConfig({ configPath });
    expect(config.network.caCert).toBeNull();
    expect(config.network.proxy).toBeNull();
    expect(config.network.strictSsl).toBe(true);
  });

  it("network section parses ca_cert / proxy / strict_ssl from the global file", () => {
    writeFileSync(
      configPath,
      "network:\n  ca_cert: /etc/loctx/ca.pem\n  proxy: http://proxy.corp:8080\n  strict_ssl: false\n",
      "utf-8",
    );
    const config = loadConfig({ configPath });
    expect(config.network.caCert).toBe("/etc/loctx/ca.pem");
    expect(config.network.proxy).toBe("http://proxy.corp:8080");
    expect(config.network.strictSsl).toBe(false);
    expect(config.sources["network.caCert"]).toBe("global");
  });

  it("global file overrides defaults", () => {
    writeFileSync(configPath, "daemon:\n  port: 4000\nembedding:\n  model: my-model\n", "utf-8");
    const config = loadConfig({ configPath });
    expect(config.daemon.port).toBe(4000);
    expect(config.embedding.model).toBe("my-model");
    expect(config.source).toBe(configPath);
    expect(config.sources["daemon.port"]).toBe("global");
    expect(config.sources["embedding.model"]).toBe("global");
    // Defaults still apply for unset keys.
    expect(config.daemon.hostname).toBe("127.0.0.1");
    expect(config.sources["daemon.hostname"]).toBe("default");
  });

  it("rejects legacy `filtering` section in the global file", () => {
    writeFileSync(configPath, "filtering:\n  skip: true\n", "utf-8");
    expect(() => loadConfig({ configPath })).toThrow(ConfigError);
  });

  it("rejects malformed YAML", () => {
    writeFileSync(configPath, "this: is: not: valid: yaml: [\n", "utf-8");
    expect(() => loadConfig({ configPath })).toThrow(ConfigError);
  });

  it("rejects non-mapping top-level YAML", () => {
    writeFileSync(configPath, "- 1\n- 2\n", "utf-8");
    expect(() => loadConfig({ configPath })).toThrow(ConfigError);
  });

  it("flags paths source as 'env' when LOCTX_DATA_DIR is set", () => {
    const prev = process.env["LOCTX_DATA_DIR"];
    process.env["LOCTX_DATA_DIR"] = join(tmp, "alt-data");
    try {
      const config = loadConfig({ configPath });
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
      const config = loadConfig({ configPath });
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
      const config = loadConfig({ configPath });
      expect(config.embedding.providerOverride).toBeUndefined();
      expect(config.sources["embedding.providerOverride"]).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env["LOCTX_EMBEDDING_PROVIDER"] = prev;
    }
  });

  it("retrieval defaults to hybrid mode with k=60", () => {
    const config = loadConfig({ configPath });
    expect(config.retrieval.mode).toBe("hybrid");
    expect(config.retrieval.rrfK).toBe(60);
    expect(config.sources["retrieval.mode"]).toBe("default");
    expect(config.sources["retrieval.rrfK"]).toBe("default");
  });

  it("global retrieval section overrides defaults", () => {
    writeFileSync(configPath, "retrieval:\n  mode: vector\n  rrf_k: 100\n", "utf-8");
    const config = loadConfig({ configPath });
    expect(config.retrieval.mode).toBe("vector");
    expect(config.retrieval.rrfK).toBe(100);
    expect(config.sources["retrieval.mode"]).toBe("global");
    expect(config.sources["retrieval.rrfK"]).toBe("global");
  });

  it("rejects an unknown retrieval.mode", () => {
    writeFileSync(configPath, "retrieval:\n  mode: bogus\n", "utf-8");
    expect(() => loadConfig({ configPath })).toThrow(ConfigError);
  });
});

describe("summarizeLegacyProjectConfig", () => {
  it("returns flat leaf=value entries for a legacy daemon config", () => {
    const legacy = join(tmp, ".loctx.yaml");
    writeFileSync(legacy, "daemon:\n  port: 3022\n  hostname: localhost\n", "utf-8");
    expect(summarizeLegacyProjectConfig(legacy).sort()).toEqual([
      'daemon.hostname="localhost"',
      "daemon.port=3022",
    ]);
  });

  it("returns empty for an empty file (safe-to-delete signal)", () => {
    const legacy = join(tmp, ".loctx.yaml");
    writeFileSync(legacy, "", "utf-8");
    expect(summarizeLegacyProjectConfig(legacy)).toEqual([]);
  });

  it("flags unparseable YAML rather than crashing", () => {
    const legacy = join(tmp, ".loctx.yaml");
    writeFileSync(legacy, ":\n:\nnot: [valid: yaml\n", "utf-8");
    const summary = summarizeLegacyProjectConfig(legacy);
    expect(summary.length).toBe(1);
    expect(summary[0]).toMatch(/unparseable/);
  });
});
