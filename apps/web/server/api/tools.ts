import { join } from "node:path";
import {
  type Config,
  detectLizard,
  installLizard,
  managedLizardCommand,
  type Runtime,
  writeConfigPatch,
} from "@loctx/core";
import type { Hono } from "hono";
import type { ToolsInstallResponse, ToolsStatusPayload } from "../../shared/contracts.js";

/**
 * Optional analyzer tools (currently lizard). `/api/tools/status` reports
 * what's missing so the UI can nudge; `/api/tools/install` provisions the
 * tool into loctx's managed venv, enables it, and backfills it over the
 * already-indexed files — the same proactive flow as `loctx install-tools`.
 */
export function mountTools(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
  onConfigWrite?: () => void | Promise<void>,
): void {
  app.get("/api/tools/status", async (c) => {
    const command = config.analyzers.lizard.command;
    const installed = (await detectLizard(command)) !== null;
    const payload: ToolsStatusPayload = {
      tools: [
        {
          name: "lizard",
          enabled: config.analyzers.lizard.enabled,
          installed,
          command,
          managedPath: managedLizardCommand(config),
        },
      ],
    };
    return c.json(payload);
  });

  app.post("/api/tools/install", async (c) => {
    // Only lizard for now (semgrep/ast-grep need rule dirs / a binary fetch).
    const result = await installLizard(config);
    if (!result.ok || result.command === undefined) {
      const fail: ToolsInstallResponse = { ok: false, tool: "lizard", error: result.error ?? "install failed" };
      return c.json(fail, 500);
    }
    const patch = {
      "analyzers.backgroundEnabled": true,
      "analyzers.lizard.enabled": true,
      "analyzers.lizard.command": result.command,
    };
    const path = config.source ?? join(config.paths.configDir, "config.yaml");
    const w = writeConfigPatch(path, patch);
    if (!w.ok) {
      const fail: ToolsInstallResponse = { ok: false, tool: "lizard", error: "config write rejected" };
      return c.json(fail, 500);
    }
    // Reload the daemon's live config so the new command + enabled flag take
    // effect, then explicitly backfill lizard over already-indexed files.
    await onConfigWrite?.();
    let backfilled = 0;
    try {
      const rt = await getRuntime();
      backfilled = (await rt.backfillAnalyzers(["lizard"])).enqueued;
    } catch {
      // runtime not ready (model still downloading) — the next reconcile /
      // restart's startup backfill will catch up.
    }
    const ok: ToolsInstallResponse = { ok: true, tool: "lizard", command: result.command, backfilled };
    return c.json(ok);
  });
}
