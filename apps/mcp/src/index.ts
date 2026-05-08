/**
 * Library entry — re-exports the transport-agnostic tool registry so other
 * workspace apps (e.g. apps/web's MCP route) can wire the same handlers
 * into their own transport.
 */

export {
  TOOL_DEFINITIONS,
  ToolError,
  registerTools,
  tools,
  type RefreshInput,
  type RefreshOutput,
  type SearchInput,
  type StatusInput,
  type StatusOutput,
} from "./registry.js";
