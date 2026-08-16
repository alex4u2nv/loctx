/**
 * Definition schema sources (#542 split from definitions.ts): the
 * bundled OKF default, schema-file loading, resolution, inference,
 * and the definition-file glob filter. Owns its own Ajv instance for
 * compile checks; validation-time compilation stays in
 * definitions.ts.
 */

import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

type AddFormats = (ajv: Ajv) => unknown;
const addFormats: AddFormats =
  (addFormatsModule as unknown as { default?: AddFormats }).default ??
  (addFormatsModule as unknown as AddFormats);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const compileCache = new Map<string, ValidateFunction>();

function validatorFor(spec: DefinitionSchemaSpec): ValidateFunction {
  const cached = compileCache.get(spec.id);
  if (cached !== undefined) return cached;
  const fn = ajv.compile(spec.schema);
  compileCache.set(spec.id, fn);
  return fn;
}

/** One schema applied to a definition file's frontmatter. */
export interface DefinitionSchemaSpec {
  /** Stable id, surfaced in finding ruleIds (e.g. "okf/v0.1"). */
  readonly id: string;
  /** JSON Schema validated with ajv — failures are `error` findings. */
  readonly schema: Record<string, unknown>;
  /**
   * Frontmatter keys that *should* be present but aren't strictly required —
   * missing ones become `warning` findings (OKF's recommended fields). JSON
   * Schema `required` can't express "warn", so this lives alongside it.
   */
  readonly recommended?: ReadonlyArray<string>;
}

/** Bundled OKF v0.1 — the zero-config default schema. */
export const OKF_V01_SCHEMA: DefinitionSchemaSpec = Object.freeze({
  id: "okf/v0.1",
  schema: {
    $id: "okf/v0.1",
    type: "object",
    required: ["type"],
    properties: {
      type: { type: "string", minLength: 1 },
      title: { type: "string" },
      description: { type: "string" },
      resource: { type: "string", format: "uri" },
      tags: { type: "array", items: { type: "string" } },
      timestamp: { type: "string", format: "date-time" },
    },
    // OKF is minimally opinionated: producers may add custom fields.
    additionalProperties: true,
  },
  recommended: Object.freeze(["title", "description", "resource", "tags", "timestamp"]),
});

/** Compile-check a schema: returns the Ajv error message, or null when
 *  it compiles. Used before persisting uploads. */
export function compileDefinitionSchema(schema: Record<string, unknown>): string | null {
  try {
    ajv.compile(schema);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// ---- schema resolution + file selection (pipeline helpers) -------------

const fileSchemaCache = new Map<string, DefinitionSchemaSpec | null>();

/** Load a JSON-Schema file (JSON or YAML) as a DefinitionSchemaSpec. */
export function loadSchemaFile(path: string): DefinitionSchemaSpec | null {
  const cached = fileSchemaCache.get(path);
  if (cached !== undefined) return cached;
  let spec: DefinitionSchemaSpec | null = null;
  try {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = parseYaml(raw);
    }
    if (parsed !== null && typeof parsed === "object") {
      spec = { id: path, schema: parsed as Record<string, unknown> };
    }
  } catch {
    spec = null;
  }
  fileSchemaCache.set(path, spec);
  return spec;
}

/**
 * Resolve the active schema set: the bundled OKF default (optional) plus any
 * local schema files. URL sources are skipped here — the web layer fetches +
 * caches those to a local path first. Schemas that don't compile are dropped
 * so one bad file can't break the analyzer.
 */
export function resolveDefinitionSchemas(
  okfDefault: boolean,
  sources: ReadonlyArray<string>,
): DefinitionSchemaSpec[] {
  const specs: DefinitionSchemaSpec[] = [];
  if (okfDefault) specs.push(OKF_V01_SCHEMA);
  for (const src of sources) {
    if (/^https?:\/\//i.test(src)) continue;
    const spec = loadSchemaFile(src);
    if (spec !== null) specs.push(spec);
  }
  return specs.filter((s) => {
    try {
      validatorFor(s);
      return true;
    } catch {
      return false;
    }
  });
}

function jsonSchemaType(v: unknown): string | null {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(v) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return null;
  }
}

/**
 * Infer a JSON Schema from a set of existing frontmatter objects: properties
 * = union of keys (typed by first-seen, dropped on type conflict), required =
 * keys present in every file. A starting point the user edits, not gospel.
 */
export function inferDefinitionSchema(
  frontmatters: ReadonlyArray<Record<string, unknown>>,
  id = "generated/v1",
): Record<string, unknown> {
  const properties: Record<string, { type?: string }> = {};
  const counts: Record<string, number> = {};
  const conflicted = new Set<string>();
  for (const fm of frontmatters) {
    for (const [key, value] of Object.entries(fm)) {
      counts[key] = (counts[key] ?? 0) + 1;
      const t = jsonSchemaType(value);
      if (conflicted.has(key)) continue;
      const existing = properties[key];
      if (existing === undefined) properties[key] = t === null ? {} : { type: t };
      else if (existing.type !== t) {
        // Mixed types across files — leave it unconstrained.
        properties[key] = {};
        conflicted.add(key);
      }
    }
  }
  const total = frontmatters.length;
  const required = Object.keys(counts)
    .filter((k) => counts[k] === total)
    .sort();
  return {
    $id: id,
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties,
    additionalProperties: true,
  };
}

const globMatchers = new Map<ReadonlyArray<string>, (p: string) => boolean>();

/** True when a project-relative path matches any of the definition globs. */
export function matchesDefinitionGlobs(relPath: string, globs: ReadonlyArray<string>): boolean {
  if (globs.length === 0) return false;
  let match = globMatchers.get(globs);
  if (match === undefined) {
    match = picomatch([...globs], { dot: true });
    globMatchers.set(globs, match);
  }
  // Normalize Windows separators so globs (always "/") match.
  return match(relPath.split(sep).join("/"));
}
