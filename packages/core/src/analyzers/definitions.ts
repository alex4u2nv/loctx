/**
 * Definitions analyzer — validates agent / skill / knowledge markdown files
 * against a schema (#okf).
 *
 * Where Semgrep/ast-grep lint *code*, this validates the **YAML frontmatter**
 * of markdown "definition" files (agents, skills, OKF concept docs) against a
 * JSON Schema. The bundled default is Google's Open Knowledge Format (OKF)
 * v0.1: a directory of markdown files whose only required frontmatter field is
 * `type`, with recommended `title` / `description` / `resource` / `tags` /
 * `timestamp`. Users can layer additional schemas (their own, Glean's, …) — all
 * go through the same ajv path, so an uploaded JSON Schema validates the same
 * way the default does.
 *
 * This module is the engine only: pure `validateDefinition` + a thin
 * file-reading `runDefinitions`. Pipeline wiring (config, dispatch, UI) lands
 * in later phases. Cross-link integrity (resolving relative markdown links) is
 * a separate pass, not schema validation.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";
import type { DefinitionSchemaSpec } from "./definitions-schemas.js";
import { capFindings, type RulePackFileResult, type RulePackFinding } from "./rule-pack.js";

// ajv-formats ships an ESM-style default over a CJS runtime; under NodeNext +
// verbatimModuleSyntax the resolved binding isn't typed callable, so bind it to
// an explicit signature (handling both `module` and `module.default` shapes).
type AddFormats = (ajv: Ajv) => unknown;
const addFormats: AddFormats =
  (addFormatsModule as unknown as { default?: AddFormats }).default ??
  (addFormatsModule as unknown as AddFormats);

export const DEFINITIONS_VERSION = 1;

export interface RunDefinitionsOptions {
  /** Active schemas; a file is validated against every one. */
  readonly schemas: ReadonlyArray<DefinitionSchemaSpec>;
  readonly maxFindingsPerFile: number;
  /** When true, a file with no frontmatter at all is an `error`. */
  readonly requireFrontmatter?: boolean;
  /** When true, flag relative markdown links that don't resolve to a file. */
  readonly checkLinks?: boolean;
}

// One shared ajv instance; validators are compiled + cached per schema $id.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();

function validatorFor(spec: DefinitionSchemaSpec): ValidateFunction {
  const cached = validators.get(spec.id);
  if (cached !== undefined) return cached;
  const compiled = ajv.compile(spec.schema);
  validators.set(spec.id, compiled);
  return compiled;
}

/** Validate that an object is a compilable JSON Schema. Returns an error

/** Extract the YAML frontmatter block. `null` data = no frontmatter found. */
export function extractFrontmatter(content: string): {
  readonly data: unknown;
  readonly present: boolean;
  /** 1-indexed last line of the frontmatter block (the closing `---`). */
  readonly endLine: number;
  readonly parseError: string | null;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { data: null, present: false, endLine: 0, parseError: null };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data: null, present: false, endLine: 0, parseError: "unterminated frontmatter block" };
  }
  const body = lines.slice(1, end).join("\n");
  try {
    return { data: parseYaml(body) ?? {}, present: true, endLine: end + 1, parseError: null };
  } catch (err) {
    return { data: null, present: true, endLine: end + 1, parseError: (err as Error).message };
  }
}

function ajvErrorToFinding(schemaId: string, err: ErrorObject, span: number): RulePackFinding {
  const where = err.instancePath
    ? err.instancePath.replace(/^\//, "")
    : ((err.params as { missingProperty?: string }).missingProperty ?? "");
  const ruleId = `${schemaId}/${err.keyword}${where ? `:${where}` : ""}`;
  const subject = where ? `\`${where}\` ` : "";
  return Object.freeze({
    ruleId,
    severity: "error" as const,
    message: `${subject}${err.message ?? "schema violation"}`.trim(),
    category: "definitions",
    lineFrom: 1,
    lineTo: span,
  });
}

/** Pure validator — content in, findings out. Used by the runner + tests. */
export function validateDefinition(
  content: string,
  opts: RunDefinitionsOptions,
): RulePackFileResult {
  const fm = extractFrontmatter(content);
  const span = Math.max(1, fm.endLine);
  const findings: RulePackFinding[] = [];

  if (!fm.present) {
    if (opts.requireFrontmatter) {
      findings.push(
        Object.freeze({
          ruleId: "definitions/missing-frontmatter",
          severity: "error",
          message: "no YAML frontmatter — definition files need a frontmatter block",
          category: "definitions",
          lineFrom: 1,
          lineTo: 1,
        }),
      );
    }
    return result(findings, opts.maxFindingsPerFile);
  }
  if (fm.parseError !== null) {
    findings.push(
      Object.freeze({
        ruleId: "definitions/invalid-yaml",
        severity: "error",
        message: `frontmatter YAML is invalid: ${fm.parseError}`,
        category: "definitions",
        lineFrom: 1,
        lineTo: span,
      }),
    );
    return result(findings, opts.maxFindingsPerFile);
  }

  const data = fm.data as Record<string, unknown>;
  for (const spec of opts.schemas) {
    const validate = validatorFor(spec);
    if (!validate(data)) {
      for (const err of validate.errors ?? []) findings.push(ajvErrorToFinding(spec.id, err, span));
    }
    for (const field of spec.recommended ?? []) {
      if (data[field] === undefined) {
        findings.push(
          Object.freeze({
            ruleId: `${spec.id}/recommended:${field}`,
            severity: "warning",
            message: `recommended field \`${field}\` is missing`,
            category: "definitions",
            lineFrom: 1,
            lineTo: span,
          }),
        );
      }
    }
  }
  return result(findings, opts.maxFindingsPerFile);
}

function result(findings: RulePackFinding[], cap: number): RulePackFileResult {
  return Object.freeze({
    analyzer: "definitions",
    toolVersion: `okf-v0.1+ajv`,
    findings: Object.freeze(capFindings(findings, cap)),
  });
}

// ---- cross-link integrity ----------------------------------------------

/** Extract inline markdown links `[text](target)` with 1-indexed line. */
export function extractMarkdownLinks(content: string): Array<{ target: string; line: number }> {
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const out: Array<{ target: string; line: number }> = [];
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    const target = m[1];
    if (target !== undefined) {
      const line = content.slice(0, m.index).split(/\r?\n/).length;
      out.push({ target, line });
    }
    m = re.exec(content);
  }
  return out;
}

function isExternalOrAnchor(target: string): boolean {
  return /^(https?:|mailto:|tel:|\/\/|#)/i.test(target);
}

/**
 * Resolve a markdown file's internal links to absolute target paths, with the
 * link text (e.g. "Full process"). External/anchor links are skipped. Used to
 * build the doc cross-link graph that powers authority ranking (#427).
 */
export function resolvedMarkdownLinks(
  content: string,
  baseDir: string,
): Array<{ toPath: string; text: string }> {
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const out: Array<{ toPath: string; text: string }> = [];
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    const text = m[1] ?? "";
    const target = m[2];
    if (target !== undefined && !isExternalOrAnchor(target)) {
      const path = target.split("#")[0];
      if (path !== undefined && path !== "") out.push({ toPath: resolve(baseDir, path), text });
    }
    m = re.exec(content);
  }
  return out;
}

/**
 * Find relative markdown links that don't resolve to an existing file. OKF's
 * cross-reference convention is relative paths; a dangling one is a warning.
 * `exists` is injected so this stays pure + testable.
 */
export function findBrokenLinks(
  content: string,
  baseDir: string,
  exists: (path: string) => boolean,
): RulePackFinding[] {
  const out: RulePackFinding[] = [];
  for (const { target, line } of extractMarkdownLinks(content)) {
    if (isExternalOrAnchor(target)) continue;
    const path = target.split("#")[0];
    if (path === undefined || path === "") continue;
    if (!exists(resolve(baseDir, path))) {
      out.push(
        Object.freeze({
          ruleId: "definitions/broken-link",
          severity: "warning",
          message: `broken relative link: ${target}`,
          category: "definitions",
          lineFrom: line,
          lineTo: line,
        }),
      );
    }
  }
  return out;
}

/** Read a definition file, validate it, and (optionally) check its links. */
export async function runDefinitions(
  filePath: string,
  opts: RunDefinitionsOptions,
): Promise<RulePackFileResult> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return result([], opts.maxFindingsPerFile);
  }
  const schemaFindings = validateDefinition(content, opts).findings;
  const linkFindings = opts.checkLinks
    ? findBrokenLinks(content, dirname(filePath), existsSync)
    : [];
  return result([...schemaFindings, ...linkFindings], opts.maxFindingsPerFile);
}

// Re-exports (#542 split): existing importers keep working through
// definitions.ts.
export * from "./definitions-schemas.js";
