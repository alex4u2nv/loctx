import { join } from "node:path";
import {
  type Config,
  detectAstGrep,
  detectLizard,
  detectSemgrep,
  installTool,
  managedToolCommand,
  type Runtime,
  type ToolName,
  TOOL_NAMES,
  writeConfigPatch,
} from "@loctx/core";
import type { Hono } from "hono";
import type { ToolsInstallResponse, ToolsStatusPayload, ToolStatus } from "../../shared/contracts.js";

/**
 * Optional analyzer tools (lizard, semgrep, ast-grep). `/api/tools/status`
 * reports what's missing so the UI can nudge; `/api/tools/install`
 * provisions the named tool into a loctx-managed location, enables it, and
 * backfills it over the index — the same flow as `loctx install-tools`.
 */
interface ToolSpec {
  readonly name: ToolName;
  detect(command: string): Promise<string | null>;
  command(config: Config): string;
  enabled(config: Config): boolean;
  /** Rule-dir count for rule-pack tools; null when N/A (lizard). */
  ruleDirCount(config: Config): number | null;
  readonly commandKey: string;
  readonly enabledKey: string;
}

const SPECS: ReadonlyArray<ToolSpec> = [
  {
    name: "lizard",
    detect: detectLizard,
    command: (c) => c.analyzers.lizard.command,
    enabled: (c) => c.analyzers.lizard.enabled,
    ruleDirCount: () => null,
    commandKey: "analyzers.lizard.command",
    enabledKey: "analyzers.lizard.enabled",
  },
  {
    name: "semgrep",
    detect: detectSemgrep,
    command: (c) => c.analyzers.semgrep.command,
    enabled: (c) => c.analyzers.semgrep.enabled,
    ruleDirCount: (c) => c.analyzers.semgrep.ruleDirs.length,
    commandKey: "analyzers.semgrep.command",
    enabledKey: "analyzers.semgrep.enabled",
  },
  {
    name: "ast-grep",
    detect: detectAstGrep,
    command: (c) => c.analyzers.astGrep.command,
    enabled: (c) => c.analyzers.astGrep.enabled,
    ruleDirCount: (c) => c.analyzers.astGrep.ruleDirs.length,
    commandKey: "analyzers.astGrep.command",
    enabledKey: "analyzers.astGrep.enabled",
  },
];

export function mountTools(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
  onConfigWrite?: () => void | Promise<void>,
): void {
  app.get("/api/tools/status", async (c) => {
    const tools: ToolStatus[] = await Promise.all(
      SPECS.map(async (s) => ({
        name: s.name,
        enabled: s.enabled(config),
        installed: (await s.detect(s.command(config))) !== null,
        command: s.command(config),
        managedPath: managedToolCommand(config, s.name),
        needsRules: s.ruleDirCount(config) === 0,
      })),
    );
    return c.json({ tools } satisfies ToolsStatusPayload);
  });

  app.post("/api/tools/install", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, tool: "?", error: "invalid JSON body" } satisfies ToolsInstallResponse, 400);
    }
    const requested = (body as { tool?: unknown } | null)?.tool;
    const spec = SPECS.find((s) => s.name === requested);
    if (spec === undefined) {
      return c.json(
        { ok: false, tool: String(requested), error: `unknown tool; expected one of ${TOOL_NAMES.join(", ")}` } satisfies ToolsInstallResponse,
        400,
      );
    }

    const result = await installTool(config, spec.name);
    if (!result.ok || result.command === undefined) {
      return c.json({ ok: false, tool: spec.name, error: result.error ?? "install failed" } satisfies ToolsInstallResponse, 500);
    }
    const patch: Record<string, unknown> = {
      "analyzers.backgroundEnabled": true,
      [spec.enabledKey]: true,
      [spec.commandKey]: result.command,
    };
    const path = config.source ?? join(config.paths.configDir, "config.yaml");
    const w = writeConfigPatch(path, patch);
    if (!w.ok) {
      return c.json({ ok: false, tool: spec.name, error: "config write rejected" } satisfies ToolsInstallResponse, 500);
    }
    await onConfigWrite?.();
    let backfilled = 0;
    try {
      const rt = await getRuntime();
      backfilled = (await rt.backfillAnalyzers([spec.name])).enqueued;
    } catch {
      // runtime not ready — startup/next reconcile backfill catches up.
    }
    return c.json({ ok: true, tool: spec.name, command: result.command, backfilled } satisfies ToolsInstallResponse);
  });
}
