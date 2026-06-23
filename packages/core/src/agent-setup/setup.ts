/**
 * Plan-then-apply for agent config setup. `planAgentSetup` reads the
 * current filesystem and computes, per agent, what loctx would write (and
 * whether each target is already in place). `applyAgentSetup` writes the
 * selected agents' targets. The split enables `--dry-run`, a UI preview,
 * and a confirm step before any write.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { AGENTS, type AgentId, type SetupContext } from "./agents.js";
import { type McpStdioSpec, mcpHttpUrl, resolveMcpStdioSpec } from "./templates.js";
import type { WriteAction } from "./writers.js";

export interface TargetPlan {
  readonly purpose: "mcp" | "rules";
  readonly path: string;
  readonly scope: "project" | "user";
  readonly action: WriteAction;
  readonly reason: string;
  /** loctx config already exists in this file (vs. would be newly added). */
  readonly present: boolean;
}

export interface AgentPlan {
  readonly id: AgentId;
  readonly label: string;
  /** True when the agent's config exists on disk — drives the nudge. */
  readonly present: boolean;
  /** Every target already in place; nothing to write. */
  readonly registered: boolean;
  readonly targets: ReadonlyArray<TargetPlan>;
}

export interface PlanOptions {
  readonly projectRoot: string;
  readonly homeDir?: string;
  readonly transport?: "stdio" | "http";
  /** Daemon port + host for the http transport URL. */
  readonly port?: number;
  readonly hostname?: string;
  /** Pre-resolved stdio spec (injected by tests; else resolved via PATH). */
  readonly stdio?: McpStdioSpec;
}

export interface AgentSetupPlan {
  readonly plans: ReadonlyArray<AgentPlan>;
  /** path → content to write, for non-skip targets. Consumed by apply. */
  readonly writes: ReadonlyMap<string, string>;
}

export interface ApplyResult {
  readonly path: string;
  readonly action: WriteAction;
  readonly ok: boolean;
  readonly error?: string;
}

function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export async function buildSetupContext(opts: PlanOptions): Promise<SetupContext> {
  return {
    projectRoot: opts.projectRoot,
    homeDir: opts.homeDir ?? homedir(),
    stdio: opts.stdio ?? (await resolveMcpStdioSpec()),
    transport: opts.transport ?? "stdio",
    httpUrl: mcpHttpUrl(opts.port ?? 0, opts.hostname ?? "localhost"),
  };
}

export async function planAgentSetup(opts: PlanOptions): Promise<AgentSetupPlan> {
  const ctx = await buildSetupContext(opts);
  const plans: AgentPlan[] = [];
  const writes = new Map<string, string>();
  for (const agent of AGENTS) {
    const targets: TargetPlan[] = [];
    for (const t of agent.targets(ctx)) {
      const cp = t.render(readMaybe(t.path));
      if (cp.action !== "skip") writes.set(t.path, cp.content);
      targets.push({
        purpose: t.purpose,
        path: t.path,
        scope: t.scope,
        action: cp.action,
        reason: cp.reason,
        present: cp.present,
      });
    }
    plans.push({
      id: agent.id,
      label: agent.label,
      present: agent.detect(ctx),
      registered: targets.every((t) => t.action === "skip"),
      targets,
    });
  }
  return { plans, writes };
}

/** Apply the plan for the selected agents. Writes only non-skip targets. */
export function applyAgentSetup(
  plan: AgentSetupPlan,
  selected: ReadonlyArray<AgentId>,
): ApplyResult[] {
  const sel = new Set(selected);
  const results: ApplyResult[] = [];
  for (const ap of plan.plans) {
    if (!sel.has(ap.id)) continue;
    for (const t of ap.targets) {
      if (t.action === "skip") {
        results.push({ path: t.path, action: "skip", ok: true });
        continue;
      }
      const content = plan.writes.get(t.path);
      if (content === undefined) {
        results.push({ path: t.path, action: t.action, ok: false, error: "no content" });
        continue;
      }
      try {
        mkdirSync(dirname(t.path), { recursive: true });
        writeFileSync(t.path, content);
        results.push({ path: t.path, action: t.action, ok: true });
      } catch (err) {
        results.push({ path: t.path, action: t.action, ok: false, error: (err as Error).message });
      }
    }
  }
  return results;
}

/** Agents that are present on disk but not yet fully registered — the set
 *  the crawl-time nudge and the UI banner care about. */
export function pendingAgents(plan: AgentSetupPlan): ReadonlyArray<AgentPlan> {
  return plan.plans.filter((p) => p.present && !p.registered);
}

/** True when any agent config in this project already contains loctx — i.e.
 *  the project is "wired" and a candidate for `--refresh`. */
export function isWired(plan: AgentSetupPlan): boolean {
  return plan.plans.some((p) => p.targets.some((t) => t.present));
}

/**
 * Bring every already-wired agent's rules/skill up to the latest template,
 * per agent: an agent counts as wired when any of its targets already
 * contains loctx (e.g. its MCP entry), and refresh then writes ALL its rules
 * targets — updating existing ones AND creating newly-introduced files like
 * the Claude skill that didn't exist when the project was first wired. The
 * MCP entry itself is left alone (so a refresh never flips an http transport
 * back to stdio), and an agent with no loctx config is never wired here.
 * Used by `setup-agent --refresh` to propagate playbook changes.
 */
export function refreshAgentSetup(plan: AgentSetupPlan): ApplyResult[] {
  const results: ApplyResult[] = [];
  for (const ap of plan.plans) {
    const agentWired = ap.targets.some((t) => t.present);
    if (!agentWired) continue;
    for (const t of ap.targets) {
      if (t.purpose === "mcp") continue; // preserve the user's transport choice
      if (t.action === "skip") continue; // already current
      const content = plan.writes.get(t.path);
      if (content === undefined) continue;
      try {
        mkdirSync(dirname(t.path), { recursive: true });
        writeFileSync(t.path, content);
        results.push({ path: t.path, action: t.action, ok: true });
      } catch (err) {
        results.push({ path: t.path, action: t.action, ok: false, error: (err as Error).message });
      }
    }
  }
  return results;
}
