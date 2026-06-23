import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAgentSetup,
  isWired,
  mergeServerJson,
  planAgentSetup,
  refreshAgentSetup,
  standaloneFile,
  upsertMarkerBlock,
} from "../../src/agent-setup/index.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

const STDIO = { command: "/usr/local/bin/loctx-mcp", args: [] as string[] };

describe("agent-setup writers", () => {
  it("mergeServerJson creates, preserves other keys, and is idempotent", () => {
    const created = mergeServerJson(null, "mcpServers", "loctx", { command: "x" });
    expect(created.action).toBe("create");
    expect(JSON.parse(created.content)).toEqual({ mcpServers: { loctx: { command: "x" } } });

    const existing = JSON.stringify({ mcpServers: { other: { command: "o" } }, theme: "dark" });
    const merged = mergeServerJson(existing, "mcpServers", "loctx", { command: "x" });
    expect(merged.action).toBe("update");
    const obj = JSON.parse(merged.content);
    expect(obj.mcpServers.other).toEqual({ command: "o" }); // preserved
    expect(obj.theme).toBe("dark"); // preserved
    expect(obj.mcpServers.loctx).toEqual({ command: "x" });

    const again = mergeServerJson(merged.content, "mcpServers", "loctx", { command: "x" });
    expect(again.action).toBe("skip");
  });

  it("mergeServerJson refuses to touch malformed JSON", () => {
    const r = mergeServerJson("{ not json", "mcpServers", "loctx", { command: "x" });
    expect(r.action).toBe("skip");
  });

  it("upsertMarkerBlock creates, refreshes its block, and preserves surrounding text", () => {
    const created = upsertMarkerBlock(null, "RULES");
    expect(created.action).toBe("create");
    expect(created.content).toContain("RULES");

    const withUserContent = `# My project\n\nSome notes.\n`;
    const appended = upsertMarkerBlock(withUserContent, "ALPHA");
    expect(appended.action).toBe("update");
    expect(appended.content).toContain("# My project");
    expect(appended.content).toContain("ALPHA");

    // Refreshing only swaps the marked block, leaves the rest intact.
    const refreshed = upsertMarkerBlock(appended.content, "BETA");
    expect(refreshed.content).toContain("# My project");
    expect(refreshed.content).toContain("BETA");
    expect(refreshed.content).not.toContain("ALPHA");

    const noop = upsertMarkerBlock(refreshed.content, "BETA");
    expect(noop.action).toBe("skip");
  });

  it("standaloneFile won't clobber an unmanaged existing file", () => {
    const ours = "<!-- loctx:start -->\nx\n<!-- loctx:end -->\n";
    expect(standaloneFile(null, ours).action).toBe("create");
    expect(standaloneFile(ours, ours).action).toBe("skip");
    expect(standaloneFile("hand-written user file", ours).action).toBe("skip");
  });
});

describe("planAgentSetup / applyAgentSetup", () => {
  it("writes MCP + rules for selected agents and is idempotent", async () => {
    const tmp = mkTmpDir("loctx-agent-");
    const home = mkTmpDir("loctx-home-");
    try {
      // Make Cursor "present" so detection flags it.
      mkdirSync(join(tmp, ".cursor"), { recursive: true });

      const plan = await planAgentSetup({ projectRoot: tmp, homeDir: home, stdio: STDIO });
      const cursor = plan.plans.find((p) => p.id === "cursor");
      expect(cursor?.present).toBe(true);
      expect(cursor?.registered).toBe(false);

      const results = applyAgentSetup(plan, ["claude", "cursor", "agents-md", "vscode"]);
      expect(results.every((r) => r.ok)).toBe(true);

      // Claude: project .mcp.json + CLAUDE.md pointer + a loctx skill.
      const mcp = JSON.parse(readFileSync(join(tmp, ".mcp.json"), "utf8"));
      expect(mcp.mcpServers.loctx.command).toBe(STDIO.command);
      expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toContain("<!-- loctx:start -->");
      const skill = readFileSync(join(tmp, ".claude", "skills", "loctx", "SKILL.md"), "utf8");
      expect(skill).toContain("name: loctx");
      expect(skill).toContain("find_usages");

      // Cursor: .cursor/mcp.json + .cursor/rules/loctx.mdc.
      expect(existsSync(join(tmp, ".cursor", "mcp.json"))).toBe(true);
      expect(readFileSync(join(tmp, ".cursor", "rules", "loctx.mdc"), "utf8")).toContain(
        "alwaysApply: true",
      );

      // AGENTS.md + VS Code servers key.
      expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toContain("loctx");
      const vscode = JSON.parse(readFileSync(join(tmp, ".vscode", "mcp.json"), "utf8"));
      expect(vscode.servers.loctx.type).toBe("stdio");

      // Re-plan: the agents we wrote are now registered.
      const plan2 = await planAgentSetup({ projectRoot: tmp, homeDir: home, stdio: STDIO });
      expect(plan2.plans.find((p) => p.id === "cursor")?.registered).toBe(true);
      expect(plan2.plans.find((p) => p.id === "claude")?.registered).toBe(true);
    } finally {
      rmTmpDir(tmp);
      rmTmpDir(home);
    }
  });

  it("merges into an existing .mcp.json without dropping other servers", async () => {
    const tmp = mkTmpDir("loctx-agent-");
    const home = mkTmpDir("loctx-home-");
    try {
      writeFileSync(
        join(tmp, ".mcp.json"),
        JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }, null, 2),
      );
      const plan = await planAgentSetup({ projectRoot: tmp, homeDir: home, stdio: STDIO });
      applyAgentSetup(plan, ["claude"]);
      const mcp = JSON.parse(readFileSync(join(tmp, ".mcp.json"), "utf8"));
      expect(mcp.mcpServers.github.command).toBe("gh-mcp"); // preserved
      expect(mcp.mcpServers.loctx.command).toBe(STDIO.command);
    } finally {
      rmTmpDir(tmp);
      rmTmpDir(home);
    }
  });

  it("refreshAgentSetup re-stamps stale rules but leaves the MCP entry + unwired projects", async () => {
    const tmp = mkTmpDir("loctx-agent-");
    const home = mkTmpDir("loctx-home-");
    try {
      // Wire the project, then stale the CLAUDE.md loctx block + tamper the
      // MCP command to prove refresh touches rules only.
      applyAgentSetup(await planAgentSetup({ projectRoot: tmp, homeDir: home, stdio: STDIO }), [
        "claude",
      ]);
      const claudeMd = join(tmp, "CLAUDE.md");
      writeFileSync(
        claudeMd,
        readFileSync(claudeMd, "utf8").replace(
          /<!-- loctx:start -->[\s\S]*?<!-- loctx:end -->/,
          "<!-- loctx:start -->\nSTALE\n<!-- loctx:end -->",
        ),
      );
      const mcpPath = join(tmp, ".mcp.json");
      writeFileSync(
        mcpPath,
        JSON.stringify({ mcpServers: { loctx: { command: "OLD" } } }, null, 2),
      );

      const plan = await planAgentSetup({ projectRoot: tmp, homeDir: home, stdio: STDIO });
      expect(isWired(plan)).toBe(true);
      refreshAgentSetup(plan);

      // Rules re-stamped to the latest playbook…
      expect(readFileSync(claudeMd, "utf8")).not.toContain("STALE");
      expect(readFileSync(claudeMd, "utf8")).toContain("find_usages");
      // …but the MCP entry is left exactly as the user had it.
      expect(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.loctx.command).toBe("OLD");

      // An unwired project is never touched.
      const bare = mkTmpDir("loctx-bare-");
      try {
        const barePlan = await planAgentSetup({ projectRoot: bare, homeDir: home, stdio: STDIO });
        expect(isWired(barePlan)).toBe(false);
        expect(refreshAgentSetup(barePlan)).toHaveLength(0);
        expect(existsSync(join(bare, "CLAUDE.md"))).toBe(false);
      } finally {
        rmTmpDir(bare);
      }
    } finally {
      rmTmpDir(tmp);
      rmTmpDir(home);
    }
  });
});
