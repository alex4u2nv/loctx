/**
 * Search Explorer mode tabs — unifies the three search routes into one
 * surface. Routes stay separate so deep-links (?q=, ?symbol=, ?pattern=)
 * and symbol→find-usages jumps keep working.
 */

import { type Tab, TabStrip } from "./tab-strip";

const SEARCH_TABS: ReadonlyArray<Tab> = [
  { to: "/search", label: "Workspace search" },
  { to: "/find-usages", label: "Find usages" },
  { to: "/find-literal", label: "Find literal" },
];

export function SearchTabs() {
  return <TabStrip tabs={SEARCH_TABS} ariaLabel="Search modes" />;
}
