/**
 * Bundled-skills install tests (#skills-distribution). Everything runs
 * against a tmp skills dir — never the real ~/.claude/skills.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySkillsInstall,
  listBundledSkills,
  planSkillsInstall,
} from "../../src/agent-setup/skills.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("bundled skills", () => {
  it("ships the three coding skills with frontmatter descriptions and no sensitive content", () => {
    const skills = listBundledSkills();
    expect(skills.map((s) => s.name)).toEqual(["code-style", "typescript", "python"]);
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.content.startsWith("---\n")).toBe(true);
      // Distribution hygiene: no user names, emails, or machine paths.
      expect(s.content).not.toMatch(/\/Users\/|@gmail|@advarra|galexia|mahabir/i);
    }
  });

  it("plans create for a fresh dir, skip for existing, overwrite with force", () => {
    const tmp = mkTmpDir("loctx-skills-");
    try {
      const fresh = planSkillsInstall({ skillsDir: tmp });
      expect(fresh.every((p) => p.action === "create" && !p.present)).toBe(true);

      mkdirSync(join(tmp, "code-style"), { recursive: true });
      writeFileSync(join(tmp, "code-style", "SKILL.md"), "customized\n");
      const withExisting = planSkillsInstall({ skillsDir: tmp });
      expect(withExisting.find((p) => p.name === "code-style")?.action).toBe("skip");
      expect(withExisting.find((p) => p.name === "typescript")?.action).toBe("create");

      const forced = planSkillsInstall({ skillsDir: tmp, force: true });
      expect(forced.find((p) => p.name === "code-style")?.action).toBe("overwrite");
    } finally {
      rmTmpDir(tmp);
    }
  });

  it("apply writes creates, preserves existing without force, overwrites with force", () => {
    const tmp = mkTmpDir("loctx-skills-");
    try {
      const first = applySkillsInstall({ skillsDir: tmp });
      expect(first.written).toBe(3);
      expect(existsSync(join(tmp, "typescript", "SKILL.md"))).toBe(true);

      writeFileSync(join(tmp, "code-style", "SKILL.md"), "customized\n");
      const second = applySkillsInstall({ skillsDir: tmp });
      expect(second.written).toBe(0);
      expect(readFileSync(join(tmp, "code-style", "SKILL.md"), "utf-8")).toBe("customized\n");

      const forced = applySkillsInstall({ skillsDir: tmp, force: true });
      expect(forced.written).toBe(3);
      expect(readFileSync(join(tmp, "code-style", "SKILL.md"), "utf-8")).not.toBe("customized\n");
    } finally {
      rmTmpDir(tmp);
    }
  });
});
