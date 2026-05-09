import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isModelTrusted,
  listTrustedModels,
  markModelTrusted,
  trustedModelStorePath,
  unmarkModelTrusted,
} from "../../src/trusted-models.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkTmpDir("loctx-trusted-");
});

afterEach(() => {
  rmTmpDir(dataDir);
});

describe("trusted-models store", () => {
  it("isModelTrusted returns false on a fresh dataDir", () => {
    expect(isModelTrusted(dataDir, "Xenova/all-MiniLM-L6-v2")).toBe(false);
  });

  it("markModelTrusted persists across reads", () => {
    markModelTrusted(dataDir, "Xenova/all-MiniLM-L6-v2");
    expect(isModelTrusted(dataDir, "Xenova/all-MiniLM-L6-v2")).toBe(true);
    // File on disk.
    expect(existsSync(trustedModelStorePath(dataDir))).toBe(true);
  });

  it("markModelTrusted is idempotent", () => {
    markModelTrusted(dataDir, "model-a");
    markModelTrusted(dataDir, "model-a");
    expect(listTrustedModels(dataDir)).toEqual(["model-a"]);
  });

  it("listTrustedModels returns sorted output", () => {
    markModelTrusted(dataDir, "z-model");
    markModelTrusted(dataDir, "a-model");
    markModelTrusted(dataDir, "m-model");
    expect(listTrustedModels(dataDir)).toEqual(["a-model", "m-model", "z-model"]);
  });

  it("unmarkModelTrusted removes a single entry", () => {
    markModelTrusted(dataDir, "model-a");
    markModelTrusted(dataDir, "model-b");
    unmarkModelTrusted(dataDir, "model-a");
    expect(isModelTrusted(dataDir, "model-a")).toBe(false);
    expect(isModelTrusted(dataDir, "model-b")).toBe(true);
  });

  it("treats a corrupt store file as empty", () => {
    writeFileSync(trustedModelStorePath(dataDir), "{not json", "utf-8");
    expect(isModelTrusted(dataDir, "anything")).toBe(false);
    // Re-marking should overwrite cleanly.
    markModelTrusted(dataDir, "model-a");
    expect(listTrustedModels(dataDir)).toEqual(["model-a"]);
  });

  it("ignores non-string entries in the JSON array", () => {
    writeFileSync(trustedModelStorePath(dataDir), JSON.stringify(["good", 42, null]), "utf-8");
    expect(listTrustedModels(dataDir)).toEqual(["good"]);
  });
});
