/**
 * Reusable modal for displaying a code chunk + metadata.
 *
 * Used by:
 *   - /projects/:id scoped-search result row click (passes SearchHit fields)
 *   - /projects/:id scoped-find-usages row click (passes UsageHit fields)
 *
 * The scaffolding (portal, backdrop, Escape) lives in <Modal>. This
 * component just wires the snippet body + optional metadata block in.
 */

import type { ReactNode } from "react";
import { Modal } from "./modal";

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
      <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
