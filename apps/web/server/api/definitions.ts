import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  type Config,
  compileDefinitionSchema,
  extractFrontmatter,
  inferDefinitionSchema,
  matchesDefinitionGlobs,
  type Runtime,
} from "@loctx/core";
import type { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import type { DefinitionSchemaResponse } from "../../shared/contracts.js";
import { jsonBody } from "../lib/http-errors.js";

/**
 * Schema management for the definitions analyzer (#okf phase 5). Stores custom
 * JSON Schemas (uploaded, fetched from a URL, or generated from the user's own
 * definition files) into a loctx-managed dir, validates they compile, and
 * returns the local path. The client appends that path to
 * `analyzers.definitions.schemas`. Generating reads the frontmatter of files
 * matching the configured globs and infers a schema as a starting point.
 */

const HEAVY_DIRS = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage)(\/|$)/;
const MAX_SCAN = 20_000;
const MAX_SAMPLES = 2_000;

function schemasDir(config: Config): string {
  return join(config.paths.dataDir, "definitions", "schemas");
}

function safeName(raw: string): string {
  const base = raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return base.length > 0 ? base.replace(/\.(json|ya?ml)$/i, "") : "schema";
}

/** Parse JSON, falling back to YAML, into an object. */
function parseSchema(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = parseYaml(text);
    } catch {
      return null;
    }
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

/** Validate + persist a schema object; returns the stored path. */
function storeSchema(config: Config, schema: Record<string, unknown>, name: string): string {
  const dir = schemasDir(config);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeName(name)}.json`);
  writeFileSync(path, JSON.stringify(schema, null, 2));
  return path;
}

export function mountDefinitions(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  // Add a custom schema by URL or inline content; validate + store it.
  app.post("/api/definitions/schema", async (c) => {
    // Uniform invalid-JSON handling (SRV-3): malformed bodies map to
    // the shared 400 `{ error: "invalid JSON body" }` shape.
    const raw = await jsonBody(c);
    const body = raw as { url?: unknown; content?: unknown; name?: unknown };
    let text: string;
    let name: string;
    if (typeof body?.url === "string" && body.url.trim() !== "") {
      const url = body.url.trim();
      if (!/^https?:\/\//i.test(url)) {
        return c.json({ ok: false, error: "url must be http(s)" } satisfies DefinitionSchemaResponse, 400);
      }
      try {
        const r = await fetch(url, { headers: { "user-agent": "loctx" } });
        if (!r.ok) {
          return c.json(
            { ok: false, error: `fetch failed: ${r.status}` } satisfies DefinitionSchemaResponse,
            400,
          );
        }
        text = await r.text();
      } catch (err) {
        return c.json(
          { ok: false, error: `fetch failed: ${(err as Error).message}` } satisfies DefinitionSchemaResponse,
          400,
        );
      }
      name =
        typeof body.name === "string" && body.name.trim() !== ""
          ? body.name
          : (url.split("/").pop() ?? "remote") || "remote";
    } else if (typeof body?.content === "string" && body.content.trim() !== "") {
      text = body.content;
      name =
        typeof body.name === "string" && body.name.trim() !== ""
          ? body.name
          : `upload-${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
    } else {
      return c.json({ ok: false, error: "provide `url` or `content`" } satisfies DefinitionSchemaResponse, 400);
    }

    const schema = parseSchema(text);
    if (schema === null) {
      return c.json({ ok: false, error: "not valid JSON or YAML" } satisfies DefinitionSchemaResponse, 400);
    }
    const err = compileDefinitionSchema(schema);
    if (err !== null) {
      return c.json({ ok: false, error: `not a valid JSON Schema: ${err}` } satisfies DefinitionSchemaResponse, 400);
    }
    const path = storeSchema(config, schema, name);
    return c.json({ ok: true, path } satisfies DefinitionSchemaResponse);
  });

  // Generate a schema by inferring it from the frontmatter of the user's own
  // definition files (those matching analyzers.definitions.globs).
  app.post("/api/definitions/schema/generate", async (c) => {
    const globs = config.analyzers.definitions.globs;
    let roots: string[];
    try {
      const rt = await getRuntime();
      roots = rt.state.listProjects().map((p) => p.root);
    } catch {
      return c.json({ ok: false, error: "runtime not ready" } satisfies DefinitionSchemaResponse, 503);
    }
    const samples: Record<string, unknown>[] = [];
    let scanned = 0;
    outer: for (const root of roots) {
      let entries: string[];
      try {
        entries = readdirSync(root, { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const rel of entries) {
        if (scanned >= MAX_SCAN || samples.length >= MAX_SAMPLES) break outer;
        scanned++;
        const relPosix = rel.split(sep).join("/");
        if (HEAVY_DIRS.test(relPosix) || !relPosix.endsWith(".md")) continue;
        if (!matchesDefinitionGlobs(relPosix, globs)) continue;
        try {
          const fm = extractFrontmatter(readFileSync(join(root, rel), "utf8"));
          if (fm.present && fm.parseError === null && fm.data !== null && typeof fm.data === "object") {
            samples.push(fm.data as Record<string, unknown>);
          }
        } catch {
          // unreadable file — skip
        }
      }
    }
    if (samples.length === 0) {
      return c.json(
        {
          ok: false,
          error: "no definition files with frontmatter matched the configured globs",
        } satisfies DefinitionSchemaResponse,
        400,
      );
    }
    const schema = inferDefinitionSchema(samples, "generated/v1");
    const path = storeSchema(config, schema, "generated");
    return c.json({ ok: true, path, scanned: samples.length } satisfies DefinitionSchemaResponse);
  });
}
