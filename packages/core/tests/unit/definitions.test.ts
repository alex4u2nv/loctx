import { describe, expect, it } from "vitest";
import {
  type DefinitionSchemaSpec,
  extractFrontmatter,
  matchesDefinitionGlobs,
  OKF_V01_SCHEMA,
  resolveDefinitionSchemas,
  validateDefinition,
} from "../../src/analyzers/definitions.js";

const OPTS = { schemas: [OKF_V01_SCHEMA], maxFindingsPerFile: 50 };

function ids(content: string, opts = OPTS): string[] {
  return validateDefinition(content, opts).findings.map((f) => f.ruleId);
}

describe("extractFrontmatter", () => {
  it("parses a frontmatter block and reports its end line", () => {
    const fm = extractFrontmatter("---\ntype: Skill\ntitle: X\n---\n# body\n");
    expect(fm.present).toBe(true);
    expect(fm.parseError).toBeNull();
    expect((fm.data as Record<string, unknown>).type).toBe("Skill");
    expect(fm.endLine).toBe(4);
  });

  it("flags no frontmatter and unterminated blocks", () => {
    expect(extractFrontmatter("# just a doc\n").present).toBe(false);
    expect(extractFrontmatter("---\ntype: X\n").parseError).toMatch(/unterminated/);
  });

  it("surfaces invalid YAML", () => {
    const fm = extractFrontmatter("---\ntype: : :\n  bad\n---\n");
    expect(fm.parseError).not.toBeNull();
  });
});

describe("validateDefinition against OKF v0.1", () => {
  it("passes a fully-specified concept with no findings", () => {
    const ok = `---
type: Skill
title: Refund handler
description: Handles refund escalations.
resource: https://example.com/skill
tags: [billing, support]
timestamp: 2026-06-24T12:00:00Z
---
body`;
    expect(validateDefinition(ok, OPTS).findings).toHaveLength(0);
  });

  it("errors when the required `type` is missing", () => {
    const r = ids(
      "---\ntitle: No type here\ndescription: d\nresource: https://x.io\ntags: [a]\ntimestamp: 2026-06-24T12:00:00Z\n---\n",
    );
    expect(r).toContain("okf/v0.1/required:type");
  });

  it("warns on missing recommended fields (but not error)", () => {
    const out = validateDefinition("---\ntype: Skill\n---\n", OPTS);
    const warnings = out.findings.filter((f) => f.severity === "warning").map((f) => f.ruleId);
    expect(warnings).toContain("okf/v0.1/recommended:title");
    expect(warnings).toContain("okf/v0.1/recommended:timestamp");
    // type is present, so no required error
    expect(out.findings.some((f) => f.severity === "error")).toBe(false);
  });

  it("errors on a malformed resource URL and bad timestamp", () => {
    const r = ids(
      "---\ntype: Skill\ntitle: t\ndescription: d\nresource: not a url\ntags: [a]\ntimestamp: yesterday\n---\n",
    );
    expect(r).toContain("okf/v0.1/format:resource");
    expect(r).toContain("okf/v0.1/format:timestamp");
  });

  it("errors when tags is not an array of strings", () => {
    const r = ids(
      "---\ntype: Skill\ntitle: t\ndescription: d\nresource: https://x.io\ntags: 5\ntimestamp: 2026-06-24T12:00:00Z\n---\n",
    );
    expect(r.some((id) => id.startsWith("okf/v0.1/type:tags"))).toBe(true);
  });

  it("allows custom frontmatter fields (OKF is minimally opinionated)", () => {
    const out = validateDefinition(
      "---\ntype: Skill\ntitle: t\ndescription: d\nresource: https://x.io\ntags: [a]\ntimestamp: 2026-06-24T12:00:00Z\ncustomField: anything\n---\n",
      OPTS,
    );
    expect(out.findings).toHaveLength(0);
  });

  it("optionally requires a frontmatter block", () => {
    expect(ids("# no frontmatter\n", { ...OPTS, requireFrontmatter: true })).toContain(
      "definitions/missing-frontmatter",
    );
    // default: no frontmatter is silent
    expect(validateDefinition("# no frontmatter\n", OPTS).findings).toHaveLength(0);
  });

  it("validates against a custom (uploaded-style) JSON Schema too", () => {
    const custom: DefinitionSchemaSpec = {
      id: "team/agent",
      schema: {
        $id: "team/agent",
        type: "object",
        required: ["name", "model"],
        properties: { name: { type: "string" }, model: { type: "string" } },
        additionalProperties: true,
      },
    };
    const r = ids("---\ntype: Agent\nname: planner\n---\n", {
      schemas: [custom],
      maxFindingsPerFile: 50,
    });
    expect(r).toContain("team/agent/required:model");
  });
});

describe("definition file selection + schema resolution", () => {
  const GLOBS = [".claude/skills/**/*.md", "**/SKILL.md", "AGENTS.md"];

  it("matches conventional definition paths and rejects generic docs", () => {
    expect(matchesDefinitionGlobs(".claude/skills/loctx/SKILL.md", GLOBS)).toBe(true);
    expect(matchesDefinitionGlobs("AGENTS.md", GLOBS)).toBe(true);
    expect(matchesDefinitionGlobs("packages/core/SKILL.md", GLOBS)).toBe(true);
    expect(matchesDefinitionGlobs("README.md", GLOBS)).toBe(false);
    expect(matchesDefinitionGlobs("src/index.ts", GLOBS)).toBe(false);
  });

  it("empty globs match nothing", () => {
    expect(matchesDefinitionGlobs("AGENTS.md", [])).toBe(false);
  });

  it("resolves the OKF default and skips URL sources (handled by the web layer)", () => {
    const specs = resolveDefinitionSchemas(true, ["https://example.com/schema.json"]);
    expect(specs.map((s) => s.id)).toEqual(["okf/v0.1"]);
    expect(resolveDefinitionSchemas(false, [])).toHaveLength(0);
  });
});
