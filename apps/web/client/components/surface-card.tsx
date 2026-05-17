/**
 * Surface card — a bordered, rounded container with an optional
 * eyebrow / title / subtitle header. The card chrome (bg, border,
 * radius, padding) was open-coded with inline styles in
 * project-detail.tsx (#255 entry 5); promoted here so the styling
 * stays consistent and future tiles converge on the same token usage.
 *
 * Most existing dashboard cards in routes/status.tsx use
 * `<article className="card">` directly — that pattern stays; this
 * component is for the lighter "compact tile" form factor (smaller
 * type, optional eyebrow, body is arbitrary children).
 */

import type { ReactNode } from "react";

export interface SurfaceCardProps {
  /** All-caps mini-label above the title (e.g. "COMPOSITION"). */
  readonly eyebrow?: string;
  readonly title?: string;
  /** One-line description rendered under the title. */
  readonly subtitle?: string;
  readonly children: ReactNode;
}

export function SurfaceCard({ eyebrow, title, subtitle, children }: SurfaceCardProps) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        padding: "var(--space-3)",
      }}
    >
      {eyebrow !== undefined ? (
        <p className="eyebrow" style={{ margin: 0, fontSize: "0.7rem" }}>
          {eyebrow}
        </p>
      ) : null}
      {title !== undefined ? (
        <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
      ) : null}
      {subtitle !== undefined ? (
        <p className="dim" style={{ margin: "0 0 var(--space-2)", fontSize: "0.75rem" }}>
          {subtitle}
        </p>
      ) : null}
      {children}
    </div>
  );
}
