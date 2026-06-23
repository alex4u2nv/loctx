/**
 * Pure content transformers for agent-config files. Each takes the current
 * file content (or null when absent) and returns the next content plus a
 * classified action — no filesystem IO, so they're trivially testable.
 *
 * All three are non-destructive: JSON merges preserve unrelated keys,
 * marker blocks touch only the loctx-delimited region, and loctx-owned
 * standalone files are never written over an unrelated user file.
 */

import { LOCTX_MARKER_END, LOCTX_MARKER_START } from "./templates.js";

export type WriteAction = "create" | "update" | "skip";

export interface ContentPlan {
  /** Full file content to write. Ignored when `action === "skip"`. */
  readonly content: string;
  readonly action: WriteAction;
  /** Human-readable explanation for the preview / logs. */
  readonly reason: string;
  /** True when loctx config already exists in this file (vs. would be newly
   *  added). `--refresh` re-stamps only present targets so it never wires a
   *  project that wasn't already wired. */
  readonly present: boolean;
}

/**
 * Merge `{ [topKey]: { [serverKey]: spec } }` into a JSON config, preserving
 * every other key (other MCP servers, unrelated settings). Idempotent:
 * re-running with an identical spec skips. Refuses to touch malformed JSON.
 */
export function mergeServerJson(
  current: string | null,
  topKey: string,
  serverKey: string,
  spec: unknown,
): ContentPlan {
  let root: Record<string, unknown> = {};
  if (current !== null && current.trim() !== "") {
    try {
      const parsed = JSON.parse(current);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      return {
        content: "",
        action: "skip",
        reason: "existing file is not valid JSON — left untouched",
        present: false,
      };
    }
  }
  const existingTop = root[topKey];
  const servers: Record<string, unknown> =
    typeof existingTop === "object" && existingTop !== null && !Array.isArray(existingTop)
      ? { ...(existingTop as Record<string, unknown>) }
      : {};
  const prev = servers[serverKey];
  const present = prev !== undefined;
  if (present && JSON.stringify(prev) === JSON.stringify(spec)) {
    return {
      content: current ?? "",
      action: "skip",
      reason: "loctx already registered with the same command",
      present: true,
    };
  }
  servers[serverKey] = spec;
  const next = { ...root, [topKey]: servers };
  return {
    content: `${JSON.stringify(next, null, 2)}\n`,
    action: current === null || current.trim() === "" ? "create" : "update",
    reason: present ? "updated loctx server entry" : "added loctx server entry",
    present,
  };
}

/**
 * Insert or refresh the loctx marker block in a shared markdown file
 * (CLAUDE.md, AGENTS.md, copilot-instructions.md), preserving everything
 * outside the markers. Creates the file when absent; appends the block
 * when the file exists without one.
 */
export function upsertMarkerBlock(current: string | null, blockBody: string): ContentPlan {
  const block = `${LOCTX_MARKER_START}\n${blockBody}\n${LOCTX_MARKER_END}`;
  if (current === null || current.trim() === "") {
    return {
      content: `${block}\n`,
      action: "create",
      reason: "created file with loctx block",
      present: false,
    };
  }
  const start = current.indexOf(LOCTX_MARKER_START);
  const end = current.indexOf(LOCTX_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const updated = current.slice(0, start) + block + current.slice(end + LOCTX_MARKER_END.length);
    return updated === current
      ? {
          content: current,
          action: "skip",
          reason: "loctx block already up to date",
          present: true,
        }
      : { content: updated, action: "update", reason: "refreshed loctx block", present: true };
  }
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  return {
    content: `${current}${sep}${block}\n`,
    action: "update",
    reason: "appended loctx block",
    present: false,
  };
}

/**
 * A loctx-owned standalone file (e.g. `.cursor/rules/loctx.mdc`,
 * `.claude/skills/loctx/SKILL.md`). The path is loctx-specific, so an
 * existing file is assumed ours and refreshed — but if it somehow exists
 * without our marker we skip rather than clobber unrelated content.
 */
export function standaloneFile(current: string | null, content: string): ContentPlan {
  if (current === null) {
    return { content, action: "create", reason: "created loctx file", present: false };
  }
  if (current === content) {
    return { content, action: "skip", reason: "already up to date", present: true };
  }
  if (current.includes(LOCTX_MARKER_START)) {
    return { content, action: "update", reason: "refreshed loctx file", present: true };
  }
  return {
    content: "",
    action: "skip",
    reason: "file exists and isn't loctx-managed — left untouched",
    present: false,
  };
}
