/**
 * Reusable modal for displaying a code chunk + metadata.
 *
 * Used by:
 *   - /projects/:id scoped-search result row click (passes SearchHit fields)
 *   - /projects/:id scoped-find-usages row click (passes UsageHit fields)
 *
 * The scaffolding (portal, backdrop, Escape) lives in <Modal>. This
 * component wires the snippet body + optional metadata block in.
 *
 * Syntax highlighting: when `language` is supplied (or inferrable from
 * the title's extension), the snippet is highlighted via Shiki. Shiki
 * is loaded with `import()` on first modal open, so the initial
 * dashboard bundle is unaffected (#256).
 */

import { type ReactNode, useEffect, useState } from "react";
import { highlightCode, languageFromPath } from "../lib/highlight";
import { Modal } from "./modal";

export interface SnippetModalProps {
  readonly title: string;
  readonly snippet: string;
  readonly onClose: () => void;
  readonly meta?: ReactNode;
  /** Optional aria-labelledby id; defaults to "snippet-modal-title". */
  readonly titleId?: string;
  /**
   * Language hint for syntax highlighting. When omitted, we attempt
   * to infer from the `title`'s file extension. Passing an empty
   * string opts out (renders plain).
   */
  readonly language?: string;
}

const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function SnippetModal({
  title,
  snippet,
  onClose,
  meta,
  titleId = "snippet-modal-title",
  language,
}: SnippetModalProps) {
  // null = not yet attempted; "" = attempted, fell back to plain text.
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const hint =
      language !== undefined && language !== ""
        ? language
        : languageFromPath(title);
    if (hint === null) {
      setHtml("");
      return;
    }
    void highlightCode(snippet, hint).then((rendered) => {
      if (!alive) return;
      setHtml(rendered ?? "");
    });
    return () => {
      alive = false;
    };
  }, [snippet, language, title]);

  return (
    <Modal
      title={title}
      titleId={titleId}
      titleStyle={{ fontFamily: MONO_STACK }}
      onClose={onClose}
      maxWidth="min(900px, 90vw)"
    >
      {meta !== undefined ? (
        <div className="modal-body" style={{ marginTop: 0 }}>
          {meta}
        </div>
      ) : null}
      {html ? (
        // Shiki emits a self-contained <pre><code>…</code></pre> with
        // inline bg/color/padding from its theme. The wrapper just
        // clips height + adds the surface border so the styling stays
        // consistent with the plain-text fallback.
        //
        // dangerouslySetInnerHTML is safe here: the input is generated
        // by Shiki from our own daemon's indexed chunk content, and
        // the container has no script execution surface. Same risk
        // profile as the plain `<code>` fallback below.
        <div
          className="snippet-pre snippet-pre-highlighted"
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-inner)",
            overflow: "auto",
            maxHeight: "60vh",
            fontSize: "0.85rem",
            lineHeight: 1.45,
            margin: 0,
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: see comment above
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-inner)",
            padding: "var(--space-3)",
            overflow: "auto",
            maxHeight: "60vh",
            fontSize: "0.85rem",
            lineHeight: 1.45,
            margin: 0,
            whiteSpace: "pre",
            fontFamily: MONO_STACK,
          }}
        >
          <code>{snippet}</code>
        </pre>
      )}
      <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
