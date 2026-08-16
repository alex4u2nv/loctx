/**
 * Embedding-model management endpoints. Mirrors `loctx model {list,
 * current, use, download}`. The download flow flips the per-process
 * outbound allow-list to "model-download" only — no other endpoint
 * should rely on it staying flipped.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  EMBEDDING_REGISTRY,
  findModel,
  isModelTrusted,
  LocalEmbeddingProvider,
  markModelTrusted,
  setAllowedOutboundReasons,
} from "@loctx/core";
import type { Hono } from "hono";
import type { ModelInfo, ModelsPayload } from "../../shared/contracts.js";
import { jsonBody } from "../lib/http-errors.js";
import { sanitizeError } from "../lib/request-validation.js";

export function mountModels(app: Hono, config: Config): void {
  app.get("/api/models", (c) => {
    const current = config.embedding.model;
    const available: ModelInfo[] = EMBEDDING_REGISTRY.map((m) => ({
      id: m.name,
      current: m.name === current,
      // The trusted-models store is the authoritative "user has downloaded
      // this" signal — `loctx model download` and POST /api/models/download
      // both call markModelTrusted on success. The actual HF cache lives
      // wherever @huggingface/transformers happens to put it (currently
      // `node_modules/@huggingface/transformers/.cache/`), which we don't
      // own and shouldn't poke at directly.
      downloaded: isModelTrusted(config.paths.dataDir, m.name),
      license: m.license,
    }));
    const payload: ModelsPayload = { current, available };
    return c.json(payload);
  });

  app.post("/api/models/use", async (c) => {
    const body = await jsonBody(c);
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name === "") return c.json({ error: "name required" }, 400);
    const info = findModel(name);
    if (info === null) return c.json({ error: `unknown model '${name}'` }, 404);

    const target = globalConfigYaml(config);
    await writeModelChoice(target, info.name, info.normalize);
    return c.json({
      ok: true,
      target,
      reindexRequired: true,
      message:
        "Existing index was built for the previous model — restart the daemon, " +
        "then `loctx reset index --force` and re-index every project. " +
        "Without the restart, in-flight searches keep hitting the old model.",
    });
  });

  app.post("/api/models/download", async (c) => {
    const body = await jsonBody(c);
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name === "") return c.json({ error: "name required" }, 400);
    const info = findModel(name);
    if (info === null) return c.json({ error: `unknown model '${name}'` }, 404);

    setAllowedOutboundReasons(["model-download"]);
    const provider = new LocalEmbeddingProvider({
      modelName: info.name,
      normalize: info.normalize,
      dataDir: config.paths.dataDir,
    });
    try {
      await provider.ensureReady();
      markModelTrusted(config.paths.dataDir, info.name);
      return c.json({ ok: true, name: info.name });
    } catch (err) {
      return c.json(
        sanitizeError("models/download", err, "model download failed; see daemon logs"),
        500,
      );
    } finally {
      await provider.dispose?.();
      // Restore the deny-all default — never leave outbound open past
      // the explicit user-triggered download.
      setAllowedOutboundReasons([]);
    }
  });
}

async function writeModelChoice(
  target: string,
  modelName: string,
  normalize: boolean,
): Promise<void> {
  const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");
  type Mutable = Record<string, unknown> & { embedding?: Record<string, unknown> };
  const existing: Mutable = existsSync(target)
    ? ((parseYaml(readFileSync(target, "utf-8"), {
        merge: false,
        maxAliasCount: 100,
      }) as Mutable | null) ?? {})
    : {};
  const embedding: Record<string, unknown> = { ...(existing.embedding ?? {}) };
  embedding["model"] = modelName;
  embedding["normalize"] = normalize;
  existing.embedding = embedding;
  writeFileSync(target, stringifyYaml(existing), "utf-8");
}

function globalConfigYaml(config: Config): string {
  return config.source ?? join(config.paths.configDir, "config.yaml");
}
