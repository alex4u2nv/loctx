/**
 * Tiny TOML reader for `corpus.toml`.
 *
 * The corpus config is intentionally minimal — one `[corpus]` table
 * with four scalar string keys — so a 50-line hand-rolled parser is
 * cheaper than pulling in `@iarna/toml` or `smol-toml`. If the schema
 * grows past scalars-only, swap to a dependency. Until then, keeping
 * the eval workspace dep-light pays back across CI.
 *
 * Supports:
 *   - line comments starting with `#`
 *   - `[section]` and `[a.b.c]` table headers
 *   - `key = "string"` and `key = 'string'`
 *
 * Rejects everything else (numbers, arrays, inline tables, multi-line
 * strings) with a sourced error so authors can fix the file rather than
 * scratching their head when an unsupported feature parses to undefined.
 */

import type { CorpusConfig } from "./types.js";

export class TomlParseError extends Error {}

type Tables = Map<string, Map<string, string>>;

export function parseCorpusToml(text: string, source = "<inline>"): CorpusConfig {
  const tables = parseScalarTables(text, source);
  const corpus = tables.get("corpus");
  if (corpus === undefined) {
    throw new TomlParseError(`${source}: missing required [corpus] table.`);
  }
  const requireKey = (k: string): string => {
    const v = corpus.get(k);
    if (v === undefined) {
      throw new TomlParseError(`${source}: [corpus] missing required key '${k}'.`);
    }
    return v;
  };
  return Object.freeze({
    name: requireKey("name"),
    repo: requireKey("repo"),
    sha: requireKey("sha"),
    indexConfig: corpus.get("index_config") ?? "default",
  });
}

function parseScalarTables(text: string, source: string): Tables {
  const tables: Tables = new Map();
  let current = "";
  let currentMap: Map<string, string> | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = stripComment(raw).trim();
    if (line === "") continue;

    const tableMatch = /^\[([^\]]+)\]$/.exec(line);
    if (tableMatch !== null) {
      const name = tableMatch[1];
      if (name === undefined) {
        throw new TomlParseError(`${source}:${i + 1}: empty table header.`);
      }
      current = name.trim();
      currentMap = tables.get(current);
      if (currentMap === undefined) {
        currentMap = new Map();
        tables.set(current, currentMap);
      }
      continue;
    }
    if (current === "" || currentMap === undefined) {
      throw new TomlParseError(
        `${source}:${i + 1}: key '${line}' is outside any [table] — top-level keys aren't supported in corpus.toml.`,
      );
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line);
    if (kv === null) {
      throw new TomlParseError(`${source}:${i + 1}: could not parse '${line}'.`);
    }
    const key = kv[1];
    const rawValue = kv[2];
    if (key === undefined || rawValue === undefined) {
      throw new TomlParseError(`${source}:${i + 1}: malformed assignment.`);
    }
    const value = parseScalarValue(rawValue.trim(), source, i + 1);
    currentMap.set(key, value);
  }
  return tables;
}

function stripComment(raw: string): string {
  // Comments live outside strings. Walk the line keeping track of the
  // current quote state; cut at the first `#` we hit while unquoted.
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === undefined) continue;
    if (inQuote !== null) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === "#") return raw.slice(0, i);
  }
  return raw;
}

function parseScalarValue(raw: string, source: string, lineNo: number): string {
  if (raw.length < 2) {
    throw new TomlParseError(
      `${source}:${lineNo}: value '${raw}' must be a quoted string — only scalar strings are supported in corpus.toml.`,
    );
  }
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return raw.slice(1, -1);
  }
  throw new TomlParseError(
    `${source}:${lineNo}: value must be a quoted string (got ${raw}). Numbers, arrays, and bare values aren't supported in corpus.toml.`,
  );
}
