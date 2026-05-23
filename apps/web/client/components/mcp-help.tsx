/**
 * Nav-level "how do I add the MCP server?" modal. The nav shows a
 * clickable `/mcp` chip — pressing it opens this dialog with the most
 * common client configurations (Claude Desktop, Claude Code, Cursor,
 * Windsurf, plus a generic block).
 *
 * Each client gets two snippets: HTTP first (recommended — reuses the
 * running daemon's loaded embeddings + DB handle) and stdio as a
 * fallback for when the daemon isn't guaranteed to be up (stdio spawns
 * a fresh process per client and pays the warmup cost each time).
 *
 * Implementation: lightweight portal-based dialog (mirrors the pattern
 * in components/confirm.tsx) instead of pulling in a dialog library.
 */

import { useEffect, useState } from "react";
import type { McpToolInfo } from "@shared/contracts";
import { api } from "../lib/api";
import { Icon } from "./icon";
import { Modal } from "./modal";

interface Snippet {
  readonly transport: "http" | "stdio";
  readonly body: string;
}

interface Example {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly snippets: readonly Snippet[];
}

const TRANSPORT_LABEL: Record<Snippet["transport"], string> = {
  http: "HTTP — recommended",
  stdio: "stdio — fallback (no daemon required)",
};

function buildExamples(httpUrl: string): readonly Example[] {
  const stdioJson = JSON.stringify(
    { mcpServers: { loctx: { command: "npx", args: ["loctx-mcp"] } } },
    null,
    2,
  );
  const httpJson = JSON.stringify({ mcpServers: { loctx: { url: httpUrl } } }, null, 2);

  return [
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      hint: "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json",
      snippets: [
        { transport: "http", body: httpJson },
        { transport: "stdio", body: stdioJson },
      ],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      hint: "Run once — registers loctx for the current user",
      snippets: [
        { transport: "http", body: `claude mcp add --transport http loctx ${httpUrl}` },
        { transport: "stdio", body: "claude mcp add loctx -- npx loctx-mcp" },
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      hint: "~/.cursor/mcp.json  (or project-local .cursor/mcp.json)",
      snippets: [
        { transport: "http", body: httpJson },
        { transport: "stdio", body: stdioJson },
      ],
    },
    {
      id: "windsurf",
      label: "Windsurf",
      hint: "~/.codeium/windsurf/mcp_config.json",
      snippets: [
        { transport: "http", body: httpJson },
        { transport: "stdio", body: stdioJson },
      ],
    },
    {
      id: "generic",
      label: "Other client",
      hint: "Standard MCP config shape — works for any client that follows the spec",
      snippets: [
        { transport: "http", body: httpJson },
        { transport: "stdio", body: stdioJson },
      ],
    },
  ];
}

type View = "setup" | "tools";

export function McpHelpModal({ onClose }: { onClose: () => void }) {
  const httpUrl = `${window.location.origin}/mcp`;
  const examples = buildExamples(httpUrl);
  const [view, setView] = useState<View>("setup");
  const [activeId, setActiveId] = useState<string>(examples[0]?.id ?? "");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [tools, setTools] = useState<readonly McpToolInfo[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .mcpTools()
      .then((p) => {
        if (!cancelled) setTools(p.tools);
      })
      .catch((err: unknown) => {
        if (!cancelled) setToolsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = examples.find((e) => e.id === activeId) ?? examples[0];
  if (active === undefined) return null;

  const copy = async (body: string, key: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1400);
    } catch {
      /* clipboard blocked — silent */
    }
  };

  return (
    <Modal
      title="Add loctx as an MCP server"
      titleId="mcp-help-title"
      onClose={onClose}
      className="modal-mcp"
    >
      <>
        <div className="mcp-view-toggle" role="tablist" aria-label="MCP modal view">
          <button
            type="button"
            role="tab"
            aria-selected={view === "setup"}
            className={`mcp-view-toggle-btn ${view === "setup" ? "is-active" : ""}`}
            onClick={() => setView("setup")}
          >
            Setup
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "tools"}
            className={`mcp-view-toggle-btn ${view === "tools" ? "is-active" : ""}`}
            onClick={() => setView("tools")}
          >
            Tools{tools !== null ? ` (${tools.length})` : ""}
          </button>
        </div>

        <div className="mcp-modal-scroll">
          {view === "setup" ? (
            <>
              <p className="modal-body" style={{ marginBottom: "var(--space-3)" }}>
                Prefer <strong>HTTP</strong> when the daemon is running — it
                reuses the loaded embedding model and DB handle. Use{" "}
                <strong>stdio</strong> when the daemon may not be up; each
                client then spawns its own short-lived loctx-mcp process.
              </p>

              <div className="mcp-tabs" role="tablist" aria-label="MCP client">
                {examples.map((ex) => (
                  <button
                    key={ex.id}
                    type="button"
                    role="tab"
                    aria-selected={ex.id === active.id}
                    className={`mcp-tab ${ex.id === active.id ? "is-active" : ""}`}
                    onClick={() => setActiveId(ex.id)}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>

              <p className="mcp-hint">{active.hint}</p>

              {active.snippets.map((snip) => {
                const key = `${active.id}.${snip.transport}`;
                return (
                  <div key={key} className="mcp-snippet-block">
                    <p className={`mcp-transport-label mcp-transport-${snip.transport}`}>
                      {TRANSPORT_LABEL[snip.transport]}
                    </p>
                    <div className="mcp-snippet-wrap">
                      <pre className="mcp-snippet">{snip.body}</pre>
                      <button
                        type="button"
                        className="btn mcp-copy"
                        onClick={() => copy(snip.body, key)}
                        aria-label={`Copy ${snip.transport} snippet`}
                      >
                        <Icon name="copy" />
                        <span>{copiedKey === key ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <section className="mcp-tools-section" aria-labelledby="mcp-tools-heading">
              <p id="mcp-tools-heading" className="mcp-tools-intro">
                These are the tools your agent receives via{" "}
                <code>tools/list</code> after connecting — same descriptions
                MCP hosts surface to the model.
              </p>
              {toolsError !== null ? (
                <p className="mcp-tools-error">Couldn't load tool list: {toolsError}</p>
              ) : tools === null ? (
                <p className="mcp-tools-loading">Loading…</p>
              ) : (
                <ul className="mcp-tools-list">
                  {tools.map((tool) => (
                    <li key={tool.name}>
                      <details className="mcp-tool">
                        <summary className="mcp-tool-summary">
                          <code className="mcp-tool-name">{tool.name}</code>
                          <Icon name="chevron-down" className="mcp-tool-chevron" />
                        </summary>
                        <p className="mcp-tool-description">{tool.description}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    </Modal>
  );
}
