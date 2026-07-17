/**
 * Coding-agent wiring: plan/apply loctx MCP registration + rules for the
 * `setup-agent` command, plus the best-effort post-activation nudge.
 */

import {
  AGENTS,
  type AgentId,
  applyAgentSetup,
  isWired,
  pendingAgents,
  planAgentSetup,
  refreshAgentSetup,
  resolveMcpStdioSpec,
  WorkspaceDiscovery,
} from "@loctx/core";
import { confirm, getCtx, loadConfigOrFail } from "./context.js";

export interface AgentSetupOpts {
  readonly requested: ReadonlyArray<string>;
  readonly transport: "stdio" | "http";
  readonly port?: number;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

/**
 * Plan + (optionally) apply loctx config for coding agents. Shared by the
 * `setup-agent` command and the post-activation nudge.
 */
export async function runAgentSetup(projectRoot: string, opts: AgentSetupOpts): Promise<void> {
  const validIds = new Set(AGENTS.map((a) => a.id));
  const unknown = opts.requested.filter((a) => !validIds.has(a as AgentId));
  if (unknown.length > 0) {
    console.error(
      `[setup-agent] unknown agent(s): ${unknown.join(", ")} (expected ${[...validIds].join(", ")})`,
    );
    process.exitCode = 1;
    return;
  }

  const plan = await planAgentSetup({
    projectRoot,
    transport: opts.transport,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  });
  const selected: AgentId[] =
    opts.requested.length > 0
      ? (opts.requested as AgentId[])
      : plan.plans.filter((p) => p.present).map((p) => p.id);

  if (selected.length === 0) {
    console.error("[setup-agent] no coding agents detected in this project.");
    console.error(`  Name one explicitly: loctx setup-agent <${[...validIds].join("|")}>`);
    return;
  }

  const selSet = new Set<AgentId>(selected);
  const selectedPlans = plan.plans.filter((p) => selSet.has(p.id));
  const changeCount = selectedPlans.reduce(
    (n, p) => n + p.targets.filter((t) => t.action !== "skip").length,
    0,
  );

  console.error(`[setup-agent] ${opts.transport} transport · ${projectRoot}`);
  for (const p of selectedPlans) {
    console.error(`  ${p.label}:`);
    for (const t of p.targets) {
      const scope = t.scope === "user" ? " (user)" : "";
      console.error(`    [${t.action}] ${t.purpose.padEnd(5)} ${t.path}${scope} — ${t.reason}`);
    }
  }
  if (changeCount === 0) {
    console.error("[setup-agent] nothing to do — selected agents already configured.");
    return;
  }
  if (opts.dryRun) {
    console.error(`[setup-agent] dry run — ${changeCount} change(s) not written.`);
    return;
  }
  if (!opts.yes && !(await confirm(`Write ${changeCount} file change(s)?`))) return;

  const results = applyAgentSetup(plan, selected);
  const wrote = results.filter((r) => r.ok && r.action !== "skip");
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.error(`  FAILED ${r.path}: ${r.error}`);
  console.error(
    `[setup-agent] wrote ${wrote.length} file(s)${failed.length > 0 ? `, ${failed.length} failed` : ""}.`,
  );
  if (opts.transport === "stdio" && wrote.length > 0) {
    console.error("  Reload your editor's MCP servers (or restart it) to pick up loctx.");
  }
}

/**
 * Re-stamp every already-wired project under workspace_roots with the latest
 * rules + skill templates. Only touches projects that already contain loctx
 * config (MCP entry left as-is) — never newly wires one. Use after a
 * playbook bump.
 */
export async function runAgentRefresh(opts: {
  transport: "stdio" | "http";
  port?: number;
}): Promise<void> {
  const config = loadConfigOrFail(getCtx());
  const stdio = await resolveMcpStdioSpec();
  const projects = new WorkspaceDiscovery(config.workspaceRoots).discoverProjects();
  let wired = 0;
  let wrote = 0;
  for (const project of projects) {
    const plan = await planAgentSetup({
      projectRoot: project.root,
      stdio,
      transport: opts.transport,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
    });
    if (!isWired(plan)) continue;
    wired += 1;
    const results = refreshAgentSetup(plan);
    const n = results.filter((r) => r.ok && r.action !== "skip").length;
    wrote += n;
    console.error(`  ${project.root}: ${n} file(s) updated`);
  }
  if (wired === 0) {
    console.error("[setup-agent] no wired projects found — run `loctx setup-agent` in one first.");
    return;
  }
  console.error(`[setup-agent] refreshed ${wired} wired project(s); ${wrote} file(s) updated.`);
}

/**
 * After activating/indexing a project, offer to wire up any coding agent
 * that's present but not yet pointed at loctx. Best-effort + interactive
 * only — never blocks or fails a non-TTY (CI / daemon-driven) run.
 */
export async function maybeNudgeAgentSetup(projectRoot: string): Promise<void> {
  if (!process.stdin.isTTY) return;
  try {
    const plan = await planAgentSetup({ projectRoot, transport: "stdio" });
    const pending = pendingAgents(plan);
    if (pending.length === 0) return;
    console.error(
      `[loctx] coding agent(s) here aren't wired to loctx yet: ${pending.map((p) => p.label).join(", ")}`,
    );
    if (await confirm("Register loctx with them now?")) {
      await runAgentSetup(projectRoot, {
        requested: pending.map((p) => p.id),
        transport: "stdio",
        dryRun: false,
        yes: true,
      });
    } else {
      console.error("  Skipped. Run `loctx setup-agent` whenever you like.");
    }
  } catch {
    // Onboarding nudge is best-effort — never let it break indexing.
  }
}
