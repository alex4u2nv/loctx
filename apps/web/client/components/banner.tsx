/**
 * Toned `.pullquote` banner (2026-08-06 audit, WEB-7). Replaces the
 * inline `borderLeftColor` styles that had spread across the routes in
 * five color variants — the tone now maps to a `pullquote-{tone}`
 * modifier class in styles.css, so a palette change lands in one place.
 *
 * `soft` keeps the default muted text with a toned border only — the
 * op-runner message banners use it (their border is warn-colored, their
 * text never was).
 */

import type { ReactNode } from "react";

export type BannerTone = "warn" | "ok" | "bad" | "info" | "muted";

export interface BannerProps {
  readonly tone: BannerTone;
  /** Keep the default text color; only the border takes the tone. */
  readonly soft?: boolean;
  readonly children: ReactNode;
}

export function Banner({ tone, soft, children }: BannerProps) {
  const cls = `pullquote pullquote-${tone}${soft === true ? " pullquote-soft" : ""}`;
  return <p className={cls}>{children}</p>;
}
