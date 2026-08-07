/**
 * config-schema.ts — effectiveSettings, the single schema-walk both the
 * web Config editor and the MCP admin_workspace get_config action read
 * their "current value" from (SRV-8).
 */

import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA, effectiveSettings } from "../../src/config-schema.js";

const FAKE_CONFIG = {
  workspaceRoots: ["/ws"],
  embedding: { provider: "huggingface-transformers", model: "test-model", normalize: true },
  mcp: { logMaxRows: 42, adminEnabled: true },
};

describe("effectiveSettings", () => {
  it("returns one entry per schema field, in schema order", () => {
    const settings = effectiveSettings(FAKE_CONFIG);
    const schemaKeys = CONFIG_SCHEMA.flatMap((s) => s.fields.map((f) => f.key));
    expect(settings.map((s) => s.key)).toEqual(schemaKeys);
  });

  it("plucks nested dot-path values off the live config tree", () => {
    const settings = effectiveSettings(FAKE_CONFIG);
    expect(settings.find((s) => s.key === "embedding.model")?.value).toBe("test-model");
    expect(settings.find((s) => s.key === "mcp.logMaxRows")?.value).toBe(42);
    expect(settings.find((s) => s.key === "workspaceRoots")?.value).toEqual(["/ws"]);
  });

  it("carries the schema's label, type, and default alongside the value", () => {
    const admin = effectiveSettings(FAKE_CONFIG).find((s) => s.key === "mcp.adminEnabled");
    expect(admin).toMatchObject({
      label: "admin_enabled",
      type: "bool",
      value: true,
      default: false,
    });
  });

  it("reports undefined for sections the config tree doesn't carry", () => {
    const settings = effectiveSettings({});
    expect(settings.find((s) => s.key === "daemon.port")?.value).toBeUndefined();
  });
});
