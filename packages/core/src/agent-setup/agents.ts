/**
 * Per-agent config formats. Each agent declares how to detect it's in use
 * and which files loctx would write (MCP registration + usage rules),
 * rendered from the shared templates. Adding an agent = one entry here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  LOCTX_MARKER_END,
  LOCTX_MARKER_START,
  type McpStdioSpec,
  RULES_BODY,
} from "./templates.js";
import { type ContentPlan, mergeServerJson, standaloneFile, upsertMarkerBlock } from "./writers.js";

export type AgentId = "claude" | "cursor" | "agents-md" | "windsurf" | "vscode";

export interface SetupContext {
  readonly projectRoot: string;
  readonly homeDir: string;
  readonly stdio: McpStdioSpec;
  /** stdio spawns the binary; http points the agent at a running daemon. */
  readonly transport: "stdio" | "http";
  readonly httpUrl: string;
}

export interface AgentTarget {
  readonly purpose: "mcp" | "rules";
  readonly path: string;
  /** MCP registration is per-project for most agents; Windsurf is user-only. */
  readonly scope: "project" | "user";
  render(current: string | null): ContentPlan;
}

export interface AgentDef {
  readonly id: AgentId;
  readonly label: string;
  /** True when this agent's config dirs/files exist — drives the nudge. */
  detect(ctx: SetupContext): boolean;
  targets(ctx: SetupContext): AgentTarget[];
}

/** The MCP server entry, in each agent's expected shape. */
function serverEntry(ctx: SetupContext, flavor: "standard" | "vscode"): unknown {
  if (ctx.transport === "http") {
    return flavor === "vscode" ? { type: "http", url: ctx.httpUrl } : { url: ctx.httpUrl };
  }
  const base = { command: ctx.stdio.command, args: [...ctx.stdio.args] };
  return flavor === "vscode" ? { type: "stdio", ...base } : base;
}

/** Cursor .mdc rule: frontmatter + a loctx-marked body so it's recognised
 *  as ours on refresh. */
function mdcRules(): string {
  return `---
description: loctx — prefer its MCP tools over grep/find for code search
alwaysApply: true
---
${LOCTX_MARKER_START}
${RULES_BODY}
${LOCTX_MARKER_END}
`;
}

/** Plain marked rules file (Windsurf). */
function markedRules(): string {
  return `${LOCTX_MARKER_START}\n${RULES_BODY}\n${LOCTX_MARKER_END}\n`;
}

export const AGENTS: ReadonlyArray<AgentDef> = [
  {
    id: "claude",
    label: "Claude Code",
    detect: (c) =>
      existsSync(join(c.projectRoot, ".claude")) ||
      existsSync(join(c.projectRoot, "CLAUDE.md")) ||
      existsSync(join(c.homeDir, ".claude")) ||
      existsSync(join(c.homeDir, ".claude.json")),
    targets: (c) => [
      {
        purpose: "mcp",
        path: join(c.projectRoot, ".mcp.json"),
        scope: "project",
        render: (cur) => mergeServerJson(cur, "mcpServers", "loctx", serverEntry(c, "standard")),
      },
      {
        purpose: "rules",
        path: join(c.projectRoot, "CLAUDE.md"),
        scope: "project",
        render: (cur) => upsertMarkerBlock(cur, RULES_BODY),
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: (c) =>
      existsSync(join(c.projectRoot, ".cursor")) ||
      existsSync(join(c.projectRoot, ".cursorrules")) ||
      existsSync(join(c.homeDir, ".cursor")),
    targets: (c) => [
      {
        purpose: "mcp",
        path: join(c.projectRoot, ".cursor", "mcp.json"),
        scope: "project",
        render: (cur) => mergeServerJson(cur, "mcpServers", "loctx", serverEntry(c, "standard")),
      },
      {
        purpose: "rules",
        path: join(c.projectRoot, ".cursor", "rules", "loctx.mdc"),
        scope: "project",
        render: (cur) => standaloneFile(cur, mdcRules()),
      },
    ],
  },
  {
    id: "agents-md",
    label: "AGENTS.md (cross-tool)",
    detect: (c) => existsSync(join(c.projectRoot, "AGENTS.md")),
    targets: (c) => [
      {
        purpose: "rules",
        path: join(c.projectRoot, "AGENTS.md"),
        scope: "project",
        render: (cur) => upsertMarkerBlock(cur, RULES_BODY),
      },
    ],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    detect: (c) =>
      existsSync(join(c.homeDir, ".codeium", "windsurf")) ||
      existsSync(join(c.projectRoot, ".windsurf")) ||
      existsSync(join(c.projectRoot, ".windsurfrules")),
    targets: (c) => [
      {
        // Windsurf's MCP config is global-only (no project scope).
        purpose: "mcp",
        path: join(c.homeDir, ".codeium", "windsurf", "mcp_config.json"),
        scope: "user",
        render: (cur) => mergeServerJson(cur, "mcpServers", "loctx", serverEntry(c, "standard")),
      },
      {
        purpose: "rules",
        path: join(c.projectRoot, ".windsurf", "rules", "loctx.md"),
        scope: "project",
        render: (cur) => standaloneFile(cur, markedRules()),
      },
    ],
  },
  {
    id: "vscode",
    label: "VS Code (Copilot)",
    detect: (c) =>
      existsSync(join(c.projectRoot, ".vscode")) ||
      existsSync(join(c.projectRoot, ".github", "copilot-instructions.md")),
    targets: (c) => [
      {
        // VS Code uses `servers` (not `mcpServers`) and a `type` discriminator.
        purpose: "mcp",
        path: join(c.projectRoot, ".vscode", "mcp.json"),
        scope: "project",
        render: (cur) => mergeServerJson(cur, "servers", "loctx", serverEntry(c, "vscode")),
      },
      {
        purpose: "rules",
        path: join(c.projectRoot, ".github", "copilot-instructions.md"),
        scope: "project",
        render: (cur) => upsertMarkerBlock(cur, RULES_BODY),
      },
    ],
  },
];

export function agentById(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}
