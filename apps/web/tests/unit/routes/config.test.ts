/**
 * GET /api/config + POST /api/config/write — payload assembly, request
 * validation, patch-write success (with the hot-reload hook), and
 * schema-rejection of a bad patch. Uses a real loadConfig against a tmp
 * config file so buildPayload / writeConfigPatch run for real.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@loctx/core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountConfig } from "../../../server/api/config.js";
import { registerErrorBoundary } from "../../../server/lib/http-errors.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loctx-cfg-"));
  configPath = join(dir, "config.yaml");
  writeFileSync(configPath, "embedding:\n  model: original-model\n", "utf-8");
});
afterEach(() => {
  delete process.env["LOCTX_DATA_DIR"];
  delete process.env["LOCTX_CONFIG_DIR"];
});

function appWithConfig(onWrite?: () => void): Hono {
  // Point both storage dirs at the tmp sandbox so loadConfig's
  // ensurePaths never touches the developer's real ~/.config.
  process.env["LOCTX_DATA_DIR"] = join(dir, "data");
  process.env["LOCTX_CONFIG_DIR"] = join(dir, "cfg");
  const config = loadConfig({ configPath });
  const app = new Hono();
  // Same error boundary production installs (SRV-3) — jsonBody's
  // invalid-JSON 400 is mapped there.
  registerErrorBoundary(app);
  mountConfig(app, config, onWrite);
  return app;
}

async function post(app: Hono, body: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request("/api/config/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

describe("GET /api/config", () => {
  it("returns the effective config, sources, and schema", async () => {
    const res = await appWithConfig().request("/api/config");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      effective: Record<string, unknown>;
      schema: unknown[];
      globalSource: string | null;
    };
    expect(payload.effective["embedding.model"]).toBe("original-model");
    expect(payload.schema.length).toBeGreaterThan(0);
    expect(payload.globalSource).toBe(configPath);
  });
});

describe("POST /api/config/write — validation", () => {
  it("400s on invalid JSON", async () => {
    expect((await post(appWithConfig(), "{ not json")).status).toBe(400);
  });

  it("400s when the body has no patch object", async () => {
    expect((await post(appWithConfig(), JSON.stringify({}))).status).toBe(400);
    expect((await post(appWithConfig(), JSON.stringify({ patch: null }))).status).toBe(400);
    expect((await post(appWithConfig(), JSON.stringify({ patch: [] }))).status).toBe(400);
  });

  it("400s with field errors when the patch fails schema validation", async () => {
    const { status, body } = await post(
      appWithConfig(),
      JSON.stringify({ patch: { "embedding.bogus": "x" } }),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false });
    expect((body as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
  });
});

describe("POST /api/config/write — success", () => {
  it("writes the patch, fires the hot-reload hook, and reports reloaded=true", async () => {
    let reloaded = false;
    const app = appWithConfig(() => {
      reloaded = true;
    });
    const { status, body } = await post(
      app,
      JSON.stringify({ patch: { "embedding.model": "new-model" } }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, reloaded: true });
    expect(readFileSync(configPath, "utf-8")).toContain("new-model");
    expect(reloaded).toBe(true);
  });

  it("still 200s with reloaded=false when the hook throws (YAML already persisted)", async () => {
    const app = appWithConfig(() => {
      throw new Error("reload failed");
    });
    const { status, body } = await post(
      app,
      JSON.stringify({ patch: { "embedding.model": "another-model" } }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, reloaded: false });
    expect(readFileSync(configPath, "utf-8")).toContain("another-model");
  });
});
