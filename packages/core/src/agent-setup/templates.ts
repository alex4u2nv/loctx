/**
 * Canonical content loctx writes into coding-agent config files: the MCP
 * server spec (so the agent can call loctx) and the usage-rules text (so
 * the agent reaches for loctx over raw grep/find). One source of truth —
 * every agent format in `agents.ts` renders from here.
 */

import { execFileAsync as exec } from "../proc.js";

/** Markers bracket loctx-owned blocks in shared files (CLAUDE.md, AGENTS.md,
 *  copilot-instructions.md) so we update only our block, never the rest. */
export const LOCTX_MARKER_START = "<!-- loctx:start -->";
export const LOCTX_MARKER_END = "<!-- loctx:end -->";

export interface McpStdioSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Resolve the command an agent should spawn for the loctx MCP server.
 * Prefers an absolute path to the installed `loctx-mcp` binary — GUI agents
 * (Cursor, VS Code) don't inherit the shell PATH on macOS, so a bare name
 * can fail to launch — and falls back to `npx loctx-mcp`.
 */
export async function resolveMcpStdioSpec(): Promise<McpStdioSpec> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await exec(finder, ["loctx-mcp"]);
    const abs = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (abs !== undefined) return { command: abs, args: [] };
  } catch {
    // not on PATH — fall back to npx, which resolves it from the registry
  }
  return { command: "npx", args: ["loctx-mcp"] };
}

/** HTTP transport URL served by a running daemon (`@loctx/web` /mcp). */
export function mcpHttpUrl(port: number, hostname = "localhost"): string {
  return `http://${hostname}:${port}/mcp`;
}

/**
 * The usage guidance. Markdown body (no heading — callers wrap it for
 * each format). Derived from the MCP tool descriptions: tells the agent
 * which loctx tool answers which class of question, and when to fall back
 * to grep.
 */
export const RULES_TITLE = "loctx — local code & docs search";

/** One-line pointer for always-on context (e.g. a CLAUDE.md block). */
export const RULES_POINTER = `This workspace is indexed by **loctx** (a local search + retrieval MCP server over code **and** prose — markdown, docs, runbooks, prompts, notes). For navigation, refactor planning, and stale-reference audits, prefer its tools — \`find_usages\`, \`search_workspace\`, \`find_literal\`, \`find_duplicates\`, \`workspace_status\` — over \`grep\`/\`find\`. They return ranked, classified, cross-referenced results with surrounding content in one call.`;

/** The full use-case playbook — shared by every agent's rules file and the
 *  Claude Code skill. Workflow-oriented, not just a tool glossary. */
export const RULES_BODY = `This workspace is indexed by **loctx**, a local search + retrieval MCP server over **code and prose alike** — source files, markdown/docs, runbooks, agent specs, prompt/skill files, and notes. Prefer its tools over raw \`grep\`/\`find\` — they return ranked, classified, cross-referenced results with the surrounding content, usually in one call.

**Which tool for which question**
- **"where is X defined / used", is this change safe** → \`find_usages\` (each hit classified def / call / import, with the surrounding chunk). Code symbols only.
- **"where is this literal / path / config key / URL referenced"** (exhaustive, code **or** docs) → \`find_literal\`.
- **"how does Y work", "where do we do Z", "where is W documented"** (no exact term) → \`search_workspace\` (semantic + lexical over code and prose; finds the chunk that implements or describes an idea without naming it).
- **duplicated code / boilerplate before refactoring** → \`find_duplicates\` (pass \`path\` to scope to one project on large workspaces).
- **"is this repo indexed / what's covered"** → \`workspace_status\`.
- **just edited files and need them seen now** → \`refresh_workspace\`.

**Use it for these workflows**
- *Unfamiliar repo:* \`workspace_status\` to confirm coverage, then \`search_workspace\` to orient before opening files.
- *Before editing or renaming a symbol:* \`find_usages\` to map every call site — don't infer the blast radius from one file.
- *Refactor planning ("what else touches X"):* \`search_workspace\` with \`coverage: true\`, or \`find_usages\`.
- *Understanding a process or runbook ("how is onboarding documented", "which doc covers X"):* \`search_workspace\` — it ranks doc/markdown sections, not just code.
- *Stale-reference audit (old URL, deprecated key, dead flag — in code or docs):* \`find_literal\`.

Fall back to \`rg\`/\`grep\` for exhaustive, safety-critical literal audits. If a loctx tool returns nothing, check \`workspace_status\` / \`indexHealth.reconciling\` before concluding the match doesn't exist.`;
