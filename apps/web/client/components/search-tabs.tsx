/**
 * Search Explorer mode tabs — unifies the three search routes into one
 * surface. Routes stay separate so deep-links (?q=, ?symbol=, ?pattern=)
 * and symbol→find-usages jumps keep working. Derived from the shared
 * route table (lib/routes.ts, audit WEB-9).
 */

import { routesInGroup } from "../lib/routes";
import { type Tab, TabStrip } from "./tab-strip";

const SEARCH_TABS: ReadonlyArray<Tab> = routesInGroup("search").map((r) => ({
  to: r.path,
  label: r.tabLabel ?? r.label,
}));

export function SearchTabs() {
  return <TabStrip tabs={SEARCH_TABS} ariaLabel="Search modes" />;
}
