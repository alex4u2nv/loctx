/**
 * Confidence tests for `writeConfigPatch` and `readLayerSnapshot`.
 *
 * The editor relies on these to: (1) modify only the keys in a patch,
 * (2) keep the surrounding YAML intact (comments, untouched keys), and
 * (3) reject bad inputs before they hit disk.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readLayerSnapshot, writeConfigPatch } from "../../src/config-writer.js";

describe("writeConfigPatch", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loctx-cfg-"));
    path = join(dir, "config.yaml");
  });

  it("preserves comments and untouched keys when patching one field", () => {
    writeFileSync(
      path,
      [
        "# Top comment",
        "embedding:",
        "  # which model",
        "  model: original-model",
        "  normalize: true",
        "watcher:",
        "  debounce_ms: 250",
        "",
      ].join("\n"),
      "utf-8",
    );

    const r = writeConfigPatch(path, { "embedding.model": "new-model" });
    expect(r.ok).toBe(true);

    const after = readFileSync(path, "utf-8");
    expect(after).toContain("# Top comment");
    expect(after).toContain("# which model");
    expect(after).toContain("new-model");
    expect(after).not.toContain("original-model");
    expect(after).toContain("normalize: true");
    expect(after).toContain("debounce_ms: 250");
  });

  it("creates intermediate sections when patching a key in an empty file", () => {
    writeFileSync(path, "", "utf-8");
    const r = writeConfigPatch(path, {
      "retrieval.mode": "vector",
      "retrieval.rrfK": 80,
    });
    expect(r.ok).toBe(true);
    const snap = readLayerSnapshot(path);
    expect(snap["retrieval.mode"]).toBe("vector");
    expect(snap["retrieval.rrfK"]).toBe(80);
  });

  it("rejects an unknown key without writing", () => {
    writeFileSync(path, "embedding:\n  model: original\n", "utf-8");
    const r = writeConfigPatch(path, { "embedding.bogus": "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].key).toBe("embedding.bogus");
    }
    expect(readFileSync(path, "utf-8")).toContain("original");
  });

  it("rejects a value that fails type validation", () => {
    writeFileSync(path, "", "utf-8");
    const r = writeConfigPatch(path, { "watcher.debounceMs": -5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/≥ 0/);
  });

  it("rejects an out-of-set enum value", () => {
    writeFileSync(path, "", "utf-8");
    const r = writeConfigPatch(path, { "retrieval.mode": "fancy" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/hybrid, vector, lexical/);
  });
});

describe("readLayerSnapshot", () => {
  it("returns {} for a missing file", () => {
    expect(readLayerSnapshot(null)).toEqual({});
    expect(readLayerSnapshot("/nope/does-not-exist.yaml")).toEqual({});
  });

  it("returns only the keys actually present in the YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "loctx-cfg-"));
    const path = join(dir, "c.yaml");
    writeFileSync(
      path,
      ["embedding:", "  model: foo", "retrieval:", "  mode: lexical", ""].join("\n"),
      "utf-8",
    );
    const snap = readLayerSnapshot(path);
    expect(snap["embedding.model"]).toBe("foo");
    expect(snap["retrieval.mode"]).toBe("lexical");
    expect(snap["embedding.normalize"]).toBeUndefined();
    expect(snap["watcher.debounceMs"]).toBeUndefined();
  });
});
