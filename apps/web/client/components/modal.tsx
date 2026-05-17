/**
 * Modal primitive. Every dialog in the admin UI renders through this.
 *
 * Owns the scaffolding that was previously copy-pasted across confirm,
 * snippet-modal, and mcp-help (#259):
 *
 *   - Portal mounting to `document.body`
 *   - `.modal-backdrop` + `.modal` styling (existing CSS)
 *   - Backdrop click → close
 *   - Escape key → close (capture-phase, beats form submit handlers)
 *   - `role="dialog"`, `aria-modal`, `aria-labelledby` plumbing
 *   - `stopPropagation` on the dialog so clicks inside don't dismiss
 *
 * Callers pass `title` (rendered as `<h3>` inside `.modal-title`) and
 * arbitrary `children`. For "no header" dialogs (rare — used by
 * confirm() with only a message) callers may omit `title` and render
 * their own structure inside children.
 *
 * Imperative `confirm()` keeps its existing wrapper API; only the
 * internals route through this primitive.
 */

import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  /** Optional heading rendered as `.modal-title`. Wires aria-labelledby. */
  readonly title?: string;
  /** Stable id for the title element. Defaults to "modal-title". */
  readonly titleId?: string;
  /** Inline style override for the title element (e.g. monospace for file paths). */
  readonly titleStyle?: React.CSSProperties;
  /** Extra class on the inner `.modal` div (e.g. `modal-mcp` size override). */
  readonly className?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Inline override for the dialog's max-width (e.g. wide code panels). */
  readonly maxWidth?: string;
}

export function Modal({
  title,
  titleId = "modal-title",
  titleStyle,
  className,
  onClose,
  children,
  maxWidth,
}: ModalProps) {
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
        className={className !== undefined ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled at window level above
        {...(maxWidth !== undefined ? { style: { maxWidth } } : {})}
      >
        {title !== undefined ? (
          <h3
            id={titleId}
            className="modal-title"
            {...(titleStyle !== undefined ? { style: titleStyle } : {})}
          >
            {title}
          </h3>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
