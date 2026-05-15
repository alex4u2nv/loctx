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
  LocalEmbeddingProvider,
  findModel,
  markModelTrusted,
  setAllowedOutboundReasons,
} from "@loctx/core";
import type { Hono } from "hono";
import type { ModelInfo, ModelsPayload } from "../../shared/contracts.js";

export function mountModels(app: Hono, config: Config): void {
  app.get("/api/models", (c) => {
    const current = config.embedding.model;
    const cacheBase = join(config.paths.dataDir, "hf-cache", "models--");
    const available: ModelInfo[] = EMBEDDING_REGISTRY.map((m) => ({
      id: m.name,
      current: m.name === current,
      // Best-effort: HF caches under `models--<name with slashes replaced>`.
      // If the cache path exists at all we treat it as downloaded; the
      // alternative is loading every model just to check, which would be
      // absurd for a status read.
      downloaded: existsSync(`${cacheBase}${m.name.replace(/\//g, "--")}`),
    }));
    const payload: ModelsPayload = { current, available };
    return c.json(payload);
  });

  app.post("/api/models/use", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const name = body?.name?.trim() ?? "";
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
        "Existing index was built for the previous model — run reset index then index, " +
        "or expect a CollectionIdentityMismatch on next start.",
    });
  });

  app.post("/api/models/download", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const name = body?.name?.trim() ?? "";
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
      return c.json({ error: (err as Error).message }, 500);
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
    ? ((parseYaml(readFileSync(target, "utf-8")) as Mutable | null) ?? {})
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
