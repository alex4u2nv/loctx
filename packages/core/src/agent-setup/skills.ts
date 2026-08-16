/**
 * Bundled coding-quality skills (#skills-distribution).
 *
 * loctx ships curated, sanitized best-practice skills — the same rules
 * its quality analyzers check for (deep-nesting remediation toolkit,
 * dispatch tables, functional idioms, validator/spec patterns) — so a
 * user can install them into their agent's USER-level skills directory
 * (`~/.claude/skills/<name>/SKILL.md`) and have every project benefit.
 *
 * Mirrors the plan-then-apply shape of agent setup (`setup.ts`): plan
 * reads the filesystem and reports per skill what an install would do;
 * apply writes only `create` (and, with force, `overwrite`) entries.
 * Non-destructive by default — an existing skill file is never touched
 * without `force`, because users customize their skills.
 *
 * Skill content is pure coding guidance: no personal data, no
 * machine paths, no project internals. `skills/*.md` are the source of
 * truth; keep them distribution-clean.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAMES = ["code-style", "typescript", "python"] as const;
export type BundledSkillName = (typeof SKILL_NAMES)[number];

export interface BundledSkill {
  readonly name: BundledSkillName;
  /** One-line summary from the skill's frontmatter. */
  readonly description: string;
  readonly content: string;
}

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("./skills", import.meta.url));
}

/** Default install target: the user-level Claude Code skills dir. */
export function defaultUserSkillsDir(): string {
  return join(homedir(), ".claude", "skills");
}

export function listBundledSkills(): BundledSkill[] {
  return SKILL_NAMES.map((name) => {
    const content = readFileSync(join(bundledSkillsDir(), `${name}.md`), "utf-8");
    return { name, description: frontmatterDescription(content), content };
  });
}

export interface SkillInstallPlan {
  readonly name: BundledSkillName;
  readonly description: string;
  /** Absolute path the skill would be written to. */
  readonly path: string;
  /** A skill file already exists at the target. */
  readonly present: boolean;
  readonly action: "create" | "skip" | "overwrite";
}

export interface SkillsInstallOptions {
  /** Override the target dir (tests, non-standard layouts). */
  readonly skillsDir?: string;
  /** Overwrite existing skill files. Default false — users customize skills. */
  readonly force?: boolean;
}

export function planSkillsInstall(opts: SkillsInstallOptions = {}): SkillInstallPlan[] {
  const dir = opts.skillsDir ?? defaultUserSkillsDir();
  return listBundledSkills().map((s) => {
    const path = join(dir, s.name, "SKILL.md");
    const present = existsSync(path);
    const action = present ? (opts.force === true ? "overwrite" : "skip") : "create";
    return { name: s.name, description: s.description, path, present, action };
  });
}

export interface SkillsInstallResult {
  readonly plans: ReadonlyArray<SkillInstallPlan>;
  readonly written: number;
  readonly skipped: number;
}

export function applySkillsInstall(opts: SkillsInstallOptions = {}): SkillsInstallResult {
  const plans = planSkillsInstall(opts);
  const byName = new Map(listBundledSkills().map((s) => [s.name, s.content]));
  let written = 0;
  for (const plan of plans) {
    if (plan.action === "skip") continue;
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, byName.get(plan.name) ?? "");
    written += 1;
  }
  return Object.freeze({
    plans: Object.freeze(plans),
    written,
    skipped: plans.length - written,
  });
}

/** First `description:` value inside the leading frontmatter block. */
function frontmatterDescription(content: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  if (fm === null) return "";
  const m = /^description:\s*(.+)$/m.exec(fm[1] ?? "");
  return m?.[1]?.trim() ?? "";
}
