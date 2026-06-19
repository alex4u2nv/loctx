import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENTS,
  type AgentId,
  applyAgentSetup,
  type Config,
  planAgentSetup,
  type Runtime,
} from "@loctx/core";
import type { Hono } from "hono";
import type { AgentSetupApplyResponse, AgentSetupPayload } from "../../shared/contracts.js";

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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const b = body as { path?: unknown; agents?: unknown } | null;
    const root = await validateRoot(b?.path);
    if (root === null) return c.json({ error: "path must be a known project root" }, 400);

    const valid = new Set<string>(AGENTS.map((a) => a.id));
    const agents = Array.isArray(b?.agents)
      ? (b.agents.filter((a): a is string => typeof a === "string" && valid.has(a)) as AgentId[])
      : [];
    if (agents.length === 0) return c.json({ error: "no valid agents specified" }, 400);

    const plan = await planAgentSetup({ projectRoot: root });
    const results = applyAgentSetup(plan, agents);
    return c.json({ ok: true, results } satisfies AgentSetupApplyResponse);
  });
}
