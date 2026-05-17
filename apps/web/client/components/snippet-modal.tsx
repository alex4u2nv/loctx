/**
 * Reusable modal for displaying a code chunk + metadata.
 *
 * Used by:
 *   - /projects/:id scoped-search result row click (passes SearchHit fields)
 *   - /projects/:id scoped-find-usages row click (passes UsageHit fields)
 *
 * The wrapper handles backdrop, focus trap (Escape closes), and the
 * standard .modal CSS. Callers pass:
 *   - title  : usually the relative file path (rendered monospace)
 *   - meta   : optional ReactNode rendered above the snippet (line range,
 *              kind, score, language, matched-by reasons, etc.)
 *   - snippet: the chunk body, rendered inside <pre><code> with a
 *              scrollable surface so very long chunks don't blow the
 *              viewport
 *   - onClose: invoked on backdrop click, Close button click, or Escape
 *
 * Keep this component dumb: any per-call-site logic (assembling the
 * meta line, formatting numbers) belongs in the caller. That keeps the
 * shared surface narrow.
 */

import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

export interface SnippetModalProps {
  readonly title: string;
  readonly snippet: string;
  readonly onClose: () => void;
  readonly meta?: ReactNode;
  /** Optional aria-labelledby id; defaults to "snippet-modal-title". */
  readonly titleId?: string;
}

const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function SnippetModal({
  title,
  snippet,
  onClose,
  meta,
  titleId = "snippet-modal-title",
}: SnippetModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={onClose}
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled at window level above
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled at window level above
        style={{ maxWidth: "min(900px, 90vw)" }}
      >
        <h3
          id={titleId}
          className="modal-title"
          style={{ fontFamily: MONO_STACK }}
        >
          {title}
        </h3>
        {meta !== undefined ? (
          <div className="modal-body" style={{ marginTop: 0 }}>
            {meta}
          </div>
        ) : null}
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
          }}
        >
          <code>{snippet}</code>
        </pre>
        <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
