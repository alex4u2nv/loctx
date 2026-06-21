/**
 * Segmented tab strip unifying the three top-level search modes into one
 * "Search Explorer" surface. Each tab is a route link (the modes stay
 * separate routes so deep-links — ?q=, ?symbol=, ?pattern= — and the
 * symbol→find-usages jumps keep working); the strip just makes switching
 * feel like one tool. The active tab is driven by the current route.
 */

import { NavLink } from "react-router-dom";

const TABS: ReadonlyArray<{ readonly to: string; readonly label: string }> = [
  { to: "/search", label: "Workspace search" },
  { to: "/find-usages", label: "Find usages" },
  { to: "/find-literal", label: "Find literal" },
];

export function SearchTabs() {
  return (
    <nav className="search-tabs" aria-label="Search modes">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} className="search-tab">
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
