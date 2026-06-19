/**
 * Agent integration: generate the file-based config coding agents (Claude
 * Code, Cursor, Windsurf, VS Code Copilot) and the cross-tool AGENTS.md
 * read — MCP server registration so they can call loctx, plus usage rules
 * so they prefer it over grep/find.
 */

export * from "./agents.js";
export * from "./setup.js";
export * from "./templates.js";
export * from "./writers.js";
