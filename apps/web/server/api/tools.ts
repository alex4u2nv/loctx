import { existsSync } from "node:fs";
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
import type {
  ToolsBackfillResponse,
  ToolsInstallResponse,
  ToolsStatusPayload,
  ToolStatus,
} from "../../shared/contracts.js";

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
  /** Configured rule dirs for rule-pack tools; null when N/A (lizard). */
  ruleDirs(config: Config): ReadonlyArray<string> | null;
  /** Registry fallback ruleset (semgrep); null for tools without one. */
  registryConfig(config: Config): string | null;
  /** Tool-specific rule directory name to auto-detect under project roots. */
  readonly autoDetectDir?: string;
  readonly commandKey: string;
  readonly enabledKey: string;
  readonly ruleDirsKey?: string;
}

const SPECS: ReadonlyArray<ToolSpec> = [
  {
    name: "lizard",
    detect: detectLizard,
    command: (c) => c.analyzers.lizard.command,
    enabled: (c) => c.analyzers.lizard.enabled,
    ruleDirs: () => null,
    registryConfig: () => null,
    commandKey: "analyzers.lizard.command",
    enabledKey: "analyzers.lizard.enabled",
  },
  {
    name: "semgrep",
    detect: detectSemgrep,
    command: (c) => c.analyzers.semgrep.command,
    enabled: (c) => c.analyzers.semgrep.enabled,
    ruleDirs: (c) => c.analyzers.semgrep.ruleDirs,
    registryConfig: (c) => c.analyzers.semgrep.registryConfig || null,
    autoDetectDir: ".semgrep",
    commandKey: "analyzers.semgrep.command",
    enabledKey: "analyzers.semgrep.enabled",
    ruleDirsKey: "analyzers.semgrep.ruleDirs",
  },
  {
    name: "ast-grep",
    detect: detectAstGrep,
    command: (c) => c.analyzers.astGrep.command,
    enabled: (c) => c.analyzers.astGrep.enabled,
    ruleDirs: (c) => c.analyzers.astGrep.ruleDirs,
    // ast-grep has no registry; loctx's bundled starter rules play that role.
    registryConfig: (c) => (c.analyzers.astGrep.bundledRules ? "bundled starter rules" : null),
    autoDetectDir: ".ast-grep",
    commandKey: "analyzers.astGrep.command",
    enabledKey: "analyzers.astGrep.enabled",
    ruleDirsKey: "analyzers.astGrep.ruleDirs",
  },
];

/** Scan known project roots for a tool's conventional rule directory. */
function autoDetectRuleDirs(roots: ReadonlyArray<string>, dirName: string): string[] {
  const found: string[] = [];
  for (const root of roots) {
    const candidate = join(root, dirName);
    if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}

export function mountTools(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
  onConfigWrite?: () => void | Promise<void>,
): void {
  app.get("/api/tools/status", async (c) => {
    const tools: ToolStatus[] = await Promise.all(
      SPECS.map(async (s) => {
        const ruleDirs = s.ruleDirs(config);
        const registryConfig = s.registryConfig(config);
        return {
          name: s.name,
          enabled: s.enabled(config),
          installed: (await s.detect(s.command(config))) !== null,
          command: s.command(config),
          managedPath: managedToolCommand(config, s.name),
          // Inert only when it's a rule-pack tool with neither local rules
          // nor a registry fallback (semgrep's p/default keeps it runnable).
          needsRules:
            ruleDirs !== null && ruleDirs.length === 0 && (registryConfig ?? "") === "",
          ruleDirs,
          registryConfig,
        };
      }),
    );
    return c.json({ tools } satisfies ToolsStatusPayload);
  });

  // Re-run an already-installed analyzer over the existing index (the
  // "Reindex" action on the Analyzers panel — install does this once, this
  // lets the user re-trigger it after editing rule dirs).
  app.post("/api/tools/backfill", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, tool: "?", error: "invalid JSON body" } satisfies ToolsBackfillResponse, 400);
    }
    const requested = (body as { tool?: unknown } | null)?.tool;
    // Backfillable analyzers — the binary tools plus the pure-JS ones
    // (duplicates, definitions) that have no install step.
    const BACKFILLABLE = new Set([...TOOL_NAMES, "duplicates", "definitions"]);
    if (typeof requested !== "string" || !BACKFILLABLE.has(requested)) {
      return c.json(
        {
          ok: false,
          tool: String(requested),
          error: `unknown analyzer; expected one of ${[...BACKFILLABLE].join(", ")}`,
        } satisfies ToolsBackfillResponse,
        400,
      );
    }
    try {
      const rt = await getRuntime();
      const { enqueued } = await rt.backfillAnalyzers([requested]);
      return c.json({ ok: true, tool: requested, backfilled: enqueued } satisfies ToolsBackfillResponse);
    } catch (err) {
      return c.json(
        { ok: false, tool: requested, error: (err as Error).message } satisfies ToolsBackfillResponse,
        503,
      );
    }
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

    console.error(`[loctx tools] installing ${spec.name}…`);
    const result = await installTool(config, spec.name);
    if (result.log) console.error(`[loctx tools] ${spec.name} install log:\n${result.log}`);
    if (!result.ok || result.command === undefined) {
      console.error(`[loctx tools] ${spec.name} install failed: ${result.error ?? "install failed"}`);
      return c.json(
        {
          ok: false,
          tool: spec.name,
          error: result.error ?? "install failed",
          ...(result.log !== undefined ? { log: result.log } : {}),
        } satisfies ToolsInstallResponse,
        500,
      );
    }
    const patch: Record<string, unknown> = {
      "analyzers.backgroundEnabled": true,
      [spec.enabledKey]: true,
      [spec.commandKey]: result.command,
    };
    // Auto-detect: if the workspace already carries this tool's conventional
    // rule directory (e.g. .semgrep / .ast-grep in a project root), point
    // rule_dirs at it so the analyzer runs the user's own rules out of the
    // box. Only when none are configured yet (don't clobber a manual set).
    if (spec.autoDetectDir !== undefined && spec.ruleDirsKey !== undefined) {
      const existing = spec.ruleDirs(config) ?? [];
      if (existing.length === 0) {
        try {
          const rt = await getRuntime();
          const roots = rt.state.listProjects().map((p) => p.root);
          const detected = autoDetectRuleDirs(roots, spec.autoDetectDir);
          if (detected.length > 0) patch[spec.ruleDirsKey] = detected;
        } catch {
          // runtime not ready — skip auto-detect, registry fallback still applies
        }
      }
    }
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
    console.error(`[loctx tools] ${spec.name} installed (${result.command}); backfill enqueued ${backfilled}`);
    return c.json(
      {
        ok: true,
        tool: spec.name,
        command: result.command,
        backfilled,
        ...(result.log !== undefined ? { log: result.log } : {}),
      } satisfies ToolsInstallResponse,
    );
  });
}
