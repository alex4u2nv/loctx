import { join } from "node:path";
import { CONFIG_SCHEMA, type Config, readLayerSnapshot, writeConfigPatch } from "@loctx/core";
import type { Hono } from "hono";
import type {
  ConfigFieldSchemaWire,
  ConfigLayerPayload,
  ConfigPayload,
  ConfigSectionSchemaWire,
  ConfigSourceKind,
  ConfigWriteError,
  ConfigWriteRequest,
  ConfigWriteResponse,
} from "../../shared/contracts.js";

export function mountConfig(
  app: Hono,
  config: Config,
  onConfigWrite?: () => void | Promise<void>,
): void {
  app.get("/api/config", (c) => {
    return c.json(buildPayload(config));
  });

  app.post("/api/config/write", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = parseRequest(raw);
    if (parsed === null) {
      return c.json({ error: "expected { patch }" }, 400);
    }

    const path = config.source ?? defaultGlobalPath(config);
    const r = writeConfigPatch(path, parsed.patch);
    if (!r.ok) {
      const failure: ConfigWriteError = { ok: false, errors: r.errors };
      return c.json(failure, 400);
    }
    // Hot-reload: re-read the YAML into the daemon's live config object so
    // the change takes effect (and the next GET /api/config reflects it)
    // without a restart. Same object the analyzer hooks read, so analyzer
    // toggles apply on the next indexed file.
    try {
      await onConfigWrite?.();
    } catch {
      // A reload failure must not fail the write — the YAML is already on
      // disk and a restart will pick it up. Surface it in the response so
      // the UI can hint that a restart may be needed.
      const success: ConfigWriteResponse = {
        ok: true,
        path: r.path,
        bytesWritten: r.bytesWritten,
        reloaded: false,
      };
      return c.json(success);
    }
    const success: ConfigWriteResponse = {
      ok: true,
      path: r.path,
      bytesWritten: r.bytesWritten,
      reloaded: onConfigWrite !== undefined,
    };
    return c.json(success);
  });
}

function buildPayload(config: Config): ConfigPayload {
  const effective = effectiveByKey(config);
  const layers: ConfigLayerPayload[] = [
    {
      kind: "global",
      path: config.source ?? defaultGlobalPath(config),
      values: readLayerSnapshot(config.source),
    },
  ];
  return {
    raw: structuredClone(config) as Config,
    globalSource: config.source,
    sources: config.sources as Readonly<Record<string, ConfigSourceKind>>,
    effective,
    layers,
    schema: schemaForWire(),
  };
}

function defaultGlobalPath(config: Config): string {
  // The `source` is null only when the global YAML doesn't exist yet;
  // we still want the editor to know where it *would* be created.
  return join(config.paths.configDir, "config.yaml");
}

function schemaForWire(): ReadonlyArray<ConfigSectionSchemaWire> {
  return CONFIG_SCHEMA.map((s) => ({
    id: s.id,
    label: s.label,
    help: s.help,
    fields: s.fields.map(
      (f): ConfigFieldSchemaWire => ({
        key: f.key,
        label: f.label,
        help: f.help,
        type: f.type,
        default: f.default,
        ...(f.enumValues ? { enumValues: f.enumValues } : {}),
        ...(f.min !== undefined ? { min: f.min } : {}),
        ...(f.max !== undefined ? { max: f.max } : {}),
      }),
    ),
  }));
}

function effectiveByKey(config: Config): Record<string, unknown> {
  // Walk the schema and pluck the merged value off the live config
  // tree so the editor's "current value" matches what the daemon
  // resolved at boot (post-env-override, post-merge).
  const out: Record<string, unknown> = {};
  for (const section of CONFIG_SCHEMA) {
    for (const f of section.fields) {
      out[f.key] = pluckByKey(config, f.key);
    }
  }
  return out;
}

function pluckByKey(config: Config, key: string): unknown {
  const path = key.split(".");
  let cur: unknown = config as unknown as Record<string, unknown>;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function parseRequest(body: unknown): ConfigWriteRequest | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const patch = b["patch"];
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return null;
  return { patch: patch as Record<string, unknown> };
}

