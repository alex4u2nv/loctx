/**
 * The single route table (2026-08-06 audit, WEB-9). Previously the
 * path/label/icon triples were declared four times — app.tsx NAV,
 * app.tsx ROUTE_LABELS, admin-tabs.tsx, search-tabs.tsx — and had to be
 * kept in sync by hand. The sidebar NAV, the header title lookup, and
 * both tab strips all derive from this array now. The `<Route>` elements
 * in app.tsx stay literal (they need element JSX), so adding a page
 * means one entry here plus one `<Route>` there.
 */

import type { IconName } from "../components/icon";

export type RouteGroup = "menu" | "search" | "admin";

export interface AppRoute {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: RouteGroup;
  /** NavLink `end` — exact match only (the "/" dashboard). */
  readonly end?: boolean;
  /** Tab-strip label when it differs from the sidebar label. */
  readonly tabLabel?: string;
}

export const ROUTES: ReadonlyArray<AppRoute> = [
  { path: "/", label: "Dashboard", icon: "dashboard", group: "menu", end: true },
  { path: "/projects", label: "Projects", icon: "projects", group: "menu" },
  {
    path: "/search",
    label: "Search",
    icon: "search",
    group: "search",
    tabLabel: "Workspace search",
  },
  { path: "/find-usages", label: "Find usages", icon: "usages", group: "search" },
  { path: "/find-literal", label: "Find literal", icon: "literal", group: "search" },
  { path: "/admin", label: "Admin", icon: "admin", group: "admin" },
  { path: "/config", label: "Config", icon: "config", group: "admin" },
  { path: "/analyzers", label: "Analyzers", icon: "analyzers", group: "admin" },
  { path: "/models", label: "Models", icon: "models", group: "admin" },
  { path: "/doctor", label: "Doctor", icon: "doctor", group: "admin" },
  { path: "/logs", label: "Logs", icon: "logs", group: "admin" },
];

export function routesInGroup(group: RouteGroup): ReadonlyArray<AppRoute> {
  return ROUTES.filter((r) => r.group === group);
}

/**
 * Header-title lookup: longest-prefix match against the route table
 * ("/projects/abc" → "Projects"). "/" is excluded — it prefixes
 * everything; the caller falls back to the dashboard label.
 */
export function routeLabelFor(pathname: string): string | null {
  const match = ROUTES.find(
    (r) => r.path !== "/" && (pathname === r.path || pathname.startsWith(`${r.path}/`)),
  );
  return match?.label ?? null;
}
