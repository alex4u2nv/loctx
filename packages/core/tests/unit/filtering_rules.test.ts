import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilteringConfigError, loadFilteringRules } from "../../src/filtering.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
beforeEach(() => {
  tmp = mkTmpDir();
});
afterEach(() => {
  rmTmpDir(tmp);
});

describe("loadFilteringRules", () => {
  it("loads bundled defaults when override dir is missing", () => {
    const rules = loadFilteringRules({ overrideDir: join(tmp, "definitely-missing") });
    expect(rules.maxFileSizeBytes).toBe(1_048_576);
    expect(rules.followSymlinks).toBe(false);
    expect(rules.ignoredDirs.has("node_modules")).toBe(true);
    expect(rules.ignoredDirs.has(".git")).toBe(true);
    expect(rules.secretGlobs.includes(".env")).toBe(true);
    expect(rules.secretAllowlistGlobs.includes(".env.example")).toBe(true);
    expect(rules.allowedExtensions.has(".py")).toBe(true);
    expect(rules.allowedNamedFiles.has("Dockerfile")).toBe(true);
  });

  it("override extends lists", () => {
    writeFileSync(
      join(tmp, "10-extra.yaml"),
      "ignored_dirs:\n  - my_skip\nallowed_extensions:\n  - .snap\nallowed_named_files:\n  - Tiltfile\n",
    );
    const rules = loadFilteringRules({ overrideDir: tmp });
    expect(rules.ignoredDirs.has("my_skip")).toBe(true);
    expect(rules.ignoredDirs.has("node_modules")).toBe(true); // baseline preserved
    expect(rules.allowedExtensions.has(".snap")).toBe(true);
    expect(rules.allowedNamedFiles.has("Tiltfile")).toBe(true);
  });

  it("override replaces scalars", () => {
    writeFileSync(
      join(tmp, "10-scalars.yaml"),
      "max_file_size_bytes: 4096\nfollow_symlinks: true\n",
    );
    const rules = loadFilteringRules({ overrideDir: tmp });
    expect(rules.maxFileSizeBytes).toBe(4096);
    expect(rules.followSymlinks).toBe(true);
  });

  it("remove_<key> subtracts from baseline", () => {
    writeFileSync(
      join(tmp, "10-remove.yaml"),
      "remove_ignored_dirs:\n  - build\nremove_secret_globs:\n  - .env\n",
    );
    const rules = loadFilteringRules({ overrideDir: tmp });
    expect(rules.ignoredDirs.has("build")).toBe(false);
    expect(rules.ignoredDirs.has("node_modules")).toBe(true);
    expect(rules.secretGlobs.includes(".env")).toBe(false);
  });

  it("merges in alphabetical filename order", () => {
    writeFileSync(join(tmp, "10-add.yaml"), "ignored_dirs:\n  - first\n");
    writeFileSync(join(tmp, "20-remove.yml"), "remove_ignored_dirs:\n  - first\n");
    const rules = loadFilteringRules({ overrideDir: tmp });
    expect(rules.ignoredDirs.has("first")).toBe(false);
  });

  it("supports both .yaml and .yml extensions", () => {
    writeFileSync(join(tmp, "01.yaml"), "allowed_extensions:\n  - .a\n");
    writeFileSync(join(tmp, "02.yml"), "allowed_extensions:\n  - .b\n");
    const rules = loadFilteringRules({ overrideDir: tmp });
    expect(rules.allowedExtensions.has(".a")).toBe(true);
    expect(rules.allowedExtensions.has(".b")).toBe(true);
  });

  it("rejects unknown keys", () => {
    writeFileSync(join(tmp, "bad.yaml"), "totally_made_up: 1\n");
    expect(() => loadFilteringRules({ overrideDir: tmp })).toThrow(FilteringConfigError);
  });

  it("rejects invalid YAML", () => {
    writeFileSync(join(tmp, "broken.yaml"), "ignored_dirs: [unterminated\n");
    expect(() => loadFilteringRules({ overrideDir: tmp })).toThrow(FilteringConfigError);
  });

  it("rejects non-mapping top-level", () => {
    writeFileSync(join(tmp, "list.yaml"), "- one\n- two\n");
    expect(() => loadFilteringRules({ overrideDir: tmp })).toThrow(/must be an object/);
  });

  it("rejects negative max_file_size_bytes", () => {
    writeFileSync(join(tmp, "neg.yaml"), "max_file_size_bytes: -1\n");
    expect(() => loadFilteringRules({ overrideDir: tmp })).toThrow(FilteringConfigError);
  });

  it("normalizes extensions to lowercase with leading dot", () => {
    writeFileSync(join(tmp, "ext.yaml"), "allowed_extensions:\n  - SNAP\n  - .Special\n");
    const rules = loadFilteringRules({ overrideDir: tmp });
    expect(rules.allowedExtensions.has(".snap")).toBe(true);
    expect(rules.allowedExtensions.has(".special")).toBe(true);
  });
});
