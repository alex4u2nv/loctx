/**
 * Imperative confirm modal. Replaces `window.confirm` so we control
 * styling and don't depend on the browser-native dialog (which routinely
 * gets blocked by extensions or rendered with browser chrome that
 * clashes with the rest of the UI).
 *
 * Usage at call sites:
 *
 *   if (!(await confirm("Drop the index?"))) return;
 *
 * The host component must be mounted exactly once high in the tree so
 * the portal target exists when `confirm()` is invoked.
 *
 * The visual scaffolding (portal, backdrop, Escape) lives in <Modal>
 * (#259). This component owns the imperative API + Enter-to-confirm
 * keystroke; Modal owns Escape-to-close and routes that to
 * `onClose=decide(false)`.
 */

import { useCallback, useEffect, useState } from "react";
import { Modal } from "./modal";

export interface ConfirmOptions {
  readonly message: string;
  readonly title?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Use the danger-styled confirm button (for destructive operations). */
  readonly danger?: boolean;
}

interface PendingRequest extends ConfirmOptions {
  readonly resolve: (decision: boolean) => void;
}

// Module-level pub/sub so call sites need no plumbing — just invoke
// `confirm()` and the singleton host picks it up.
const listeners = new Set<(req: PendingRequest) => void>();

export function confirm(messageOrOpts: string | ConfirmOptions): Promise<boolean> {
  const opts: ConfirmOptions =
    typeof messageOrOpts === "string" ? { message: messageOrOpts } : messageOrOpts;
  return new Promise<boolean>((resolve) => {
    const req: PendingRequest = { ...opts, resolve };
    if (listeners.size === 0) {
      // No host mounted — fall back to native so we never lose a
      // confirmation dialog (e.g. during early app boot). The user-facing
      // wording is the same; styling is the only thing they lose.
      resolve(globalThis.confirm(opts.message));
      return;
    }
    for (const l of listeners) l(req);
  });
}

export function ConfirmHost() {
  const [current, setCurrent] = useState<PendingRequest | null>(null);

  useEffect(() => {
    const handler = (r: PendingRequest) => setCurrent(r);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  const decide = useCallback(
    (decision: boolean) => {
      if (current === null) return;
      current.resolve(decision);
      setCurrent(null);
    },
    [current],
  );

  // Enter confirms. Escape is handled by Modal's built-in onClose path,
  // which we wire to decide(false). Capture-phase so we beat any
  // form-submit handlers listening on the page.
  useEffect(() => {
    if (current === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        decide(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, decide]);

  if (current === null) return null;

  return (
    <Modal
      onClose={() => decide(false)}
      {...(current.title !== undefined ? { title: current.title } : {})}
    >
      <p id="modal-body" className="modal-body">
        {current.message}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => decide(false)}>
          {current.cancelLabel ?? "Cancel"}
        </button>
        <button
          type="button"
          className={`btn ${current.danger ? "btn-danger" : "btn-primary"}`}
          onClick={() => decide(true)}
          ref={(el) => el?.focus()}
        >
          {current.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </Modal>
  );
}
