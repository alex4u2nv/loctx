/**
 * Segmented pill tab control over a set of routes — the shared primitive
 * behind the Search Explorer and the Admin hub. Each tab is a route link
 * (routes stay separate so deep-links keep working); the active tab tracks
 * the current location.
 */

import { NavLink } from "react-router-dom";

export interface Tab {
  readonly to: string;
  readonly label: string;
}

export function TabStrip({ tabs, ariaLabel }: { tabs: ReadonlyArray<Tab>; ariaLabel: string }) {
  return (
    <nav className="tab-strip" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} className="tab-strip-item">
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
