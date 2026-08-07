import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENTS,
  type AgentId,
  applyAgentSetup,
  type Config,
  isWired,
  planAgentSetup,
  refreshAgentSetup,
  type Runtime,
} from "@loctx/core";
import type { Hono } from "hono";
import type {
  AgentRefreshResponse,
  AgentSetupApplyResponse,
  AgentSetupPayload,
} from "../../shared/contracts.js";
import { jsonBody } from "../lib/http-errors.js";

/**
 * Agent integration for the admin UI. `GET` returns, for one project, which
 * coding agents are present and what loctx would write (project-scoped MCP
 * + usage rules); `POST` applies the selected agents. The projects page
 * surfaces this when a project is enabled.
 *
 * Safety: writes are confined to roots loctx already knows as projects — the
 * API must never write agent config to an arbitrary filesystem path.
 */

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function mountAgentSetup(
  app: Hono,
  _config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  async function validateRoot(input: unknown): Promise<string | null> {
    if (typeof input !== "string" || input.trim() === "") return null;
    const target = realOrSelf(resolve(input));
    try {
      const rt = await getRuntime();
      const roots = new Set(rt.state.listProjects().map((p) => realOrSelf(p.root)));
      return roots.has(target) ? target : null;
    } catch {
      return null;
    }
  }

  app.get("/api/agent-setup", async (c) => {
    const root = await validateRoot(c.req.query("path"));
    if (root === null) return c.json({ error: "path must be a known project root" }, 400);
    const plan = await planAgentSetup({ projectRoot: root });
    return c.json({ projectRoot: root, agents: plan.plans } satisfies AgentSetupPayload);
  });

  app.post("/api/agent-setup", async (c) => {
    const body = await jsonBody(c);
    const root = await validateRoot(body["path"]);
    if (root === null) return c.json({ error: "path must be a known project root" }, 400);

    const valid = new Set<string>(AGENTS.map((a) => a.id));
    const rawAgents = body["agents"];
    const agents = Array.isArray(rawAgents)
      ? (rawAgents.filter((a): a is string => typeof a === "string" && valid.has(a)) as AgentId[])
      : [];
    if (agents.length === 0) return c.json({ error: "no valid agents specified" }, 400);

    const plan = await planAgentSetup({ projectRoot: root });
    const results = applyAgentSetup(plan, agents);
    return c.json({ ok: true, results } satisfies AgentSetupApplyResponse);
  });

  // Re-stamp the loctx rules/skill in every already-wired known project,
  // propagating the latest playbook. Never wires a new project (MCP entry +
  // unwired projects untouched).
  app.post("/api/agent-setup/refresh", async (c) => {
    let rt: Runtime;
    try {
      rt = await getRuntime();
    } catch {
      return c.json({ error: "runtime not ready" }, 503);
    }
    const roots = [...new Set(rt.state.listProjects().map((p) => realOrSelf(p.root)))];
    const projects: Array<{ root: string; updated: number }> = [];
    let filesWritten = 0;
    for (const root of roots) {
      const plan = await planAgentSetup({ projectRoot: root });
      if (!isWired(plan)) continue;
      const results = refreshAgentSetup(plan);
      const updated = results.filter((r) => r.ok && r.action !== "skip").length;
      filesWritten += updated;
      projects.push({ root, updated });
    }
    return c.json({
      ok: true,
      wired: projects.length,
      filesWritten,
      projects,
    } satisfies AgentRefreshResponse);
  });
}
