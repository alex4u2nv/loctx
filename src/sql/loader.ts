/**
 * SQL query loader. Each `.sql` file contains one or more named sections
 * separated by `-- :name <ident>` markers; everything before the first marker
 * is a header. Section bodies may span multiple statements.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAME_RE = /^--\s*:name\s+(\w+)\s*$/;

export class SqlLoadError extends Error {}

/**
 * Load named SQL sections from a file relative to a caller-provided URL
 * (typically `import.meta.url`).
 */
export function loadQueries(filename: string, baseUrl: string): Readonly<Record<string, string>> {
  const path = fileURLToPath(new URL(filename, baseUrl));
  const text = readFileSync(path, "utf-8");

  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  const lines = text.split("\n");

  for (const [idx, raw] of lines.entries()) {
    const match = NAME_RE.exec(raw.trim());
    if (match) {
      const name = match[1];
      if (name === undefined) continue;
      if (Object.hasOwn(sections, name)) {
        throw new SqlLoadError(`${filename}:${idx + 1}: duplicate SQL section name '${name}'`);
      }
      sections[name] = [];
      current = name;
    } else if (current !== null) {
      const bucket = sections[current];
      if (bucket !== undefined) bucket.push(raw);
    }
  }

  const result: Record<string, string> = {};
  for (const [name, body] of Object.entries(sections)) {
    result[name] = body.join("\n").trim();
  }
  return Object.freeze(result);
}
