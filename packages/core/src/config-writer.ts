/**
 * Patch a layered YAML config file in place, preserving comments and
 * formatting. Used by the admin UI's `POST /api/config/write` to apply
 * partial edits to either the global or project YAML.
 *
 * Why eemeli/yaml's Document API and not js-yaml: round-trips comments,
 * blank lines, and key order — important because our default global
 * config is a heavily-commented template and rewriting it as plain
 * JSON-flavored YAML on every save would burn the user's documentation.
 *
 * Patch shape: dot-path → value (e.g. `{ "embedding.model": "X" }`).
 * The schema (`config-schema.ts`) maps dot-paths back to the YAML
 * snake_case key path before mutating the document.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Document, parseDocument } from "yaml";
import {
  CONFIG_SCHEMA,
  type FieldSchema,
  type ValidationError,
  getField,
  validatePatch,
} from "./config-schema.js";

export interface WriteResult {
  readonly ok: true;
  readonly path: string;
  readonly bytesWritten: number;
}

export interface WriteFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<ValidationError>;
}

export function writeConfigPatch(
  path: string,
  target: "global" | "project",
  patch: Record<string, unknown>,
): WriteResult | WriteFailure {
  const errors = validatePatch(patch, target);
  if (errors.length > 0) return { ok: false, errors };

  const doc = readDoc(path);
  for (const [key, value] of Object.entries(patch)) {
    const f = getField(key);
    if (f === undefined) continue; // already rejected by validatePatch
    setIn(doc, f.yamlPath, value);
  }

  const text = doc.toString({ lineWidth: 100 });
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic-ish write: stage to a sibling temp, then rename. POSIX rename
  // is atomic within a filesystem so a crashed process can't leave the
  // config half-written.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
  return { ok: true, path, bytesWritten: Buffer.byteLength(text, "utf-8") };
}

function readDoc(path: string): Document {
  if (!existsSync(path)) return new Document({});
  const raw = readFileSync(path, "utf-8");
  if (raw.trim() === "") return new Document({});
  return parseDocument(raw);
}

function setIn(doc: Document, yamlPath: ReadonlyArray<string>, value: unknown): void {
  // `Document.setIn` already creates intermediate maps as needed.
  doc.setIn([...yamlPath], value);
}

/**
 * Read the current value of every schema field from a YAML file (or
 * `null` if absent). Drives the per-layer view in the editor — "what
 * does this file actually say" vs. the merged effective config.
 */
export function readLayerSnapshot(path: string | null): Record<string, unknown> {
  if (path === null || !existsSync(path)) return {};
  const doc = readDoc(path);
  const out: Record<string, unknown> = {};
  for (const section of CONFIG_SCHEMA) {
    for (const f of section.fields) {
      const v = getInJson(doc, f.yamlPath);
      if (v !== undefined) out[f.key] = coerceForField(f, v);
    }
  }
  return out;
}

function getInJson(doc: Document, yamlPath: ReadonlyArray<string>): unknown {
  const node = doc.getIn([...yamlPath], true);
  if (node === undefined || node === null) return undefined;
  // toJS to unwrap Scalar/Pair/etc nodes into plain JS values.
  return doc.createNode(node).toJSON();
}

function coerceForField(f: FieldSchema, value: unknown): unknown {
  // YAML round-trip can hand us numbers as strings on weird quoting;
  // be conservative and leave non-matching values for the validator.
  if (f.type === "int" && typeof value === "string") {
    const n = Number(value);
    if (Number.isInteger(n)) return n;
  }
  return value;
}
