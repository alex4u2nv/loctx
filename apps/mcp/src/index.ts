/**
 * Library entry — re-exports the transport-agnostic tool registry so other
 * workspace apps (e.g. apps/web's MCP route) can wire the same handlers
 * into their own transport.
 */

export {
  type RefreshInput,
  type RefreshOutput,
  registerTools,
  type SearchInput,
  type StatusInput,
  type StatusOutput,
  TOOL_DEFINITIONS,
  ToolError,
  tools,
} from "./registry.js";
