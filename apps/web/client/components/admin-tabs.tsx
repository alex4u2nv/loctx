/**
 * Admin hub tabs — groups the workspace-wide operations + diagnostics
 * pages (operations, config, models, doctor, logs) into one surface, the
 * same way the Search Explorer groups the search modes. Routes stay
 * separate; the active tab tracks the current location. Derived from the
 * shared route table (lib/routes.ts, audit WEB-9).
 */

import { routesInGroup } from "../lib/routes";
import { type Tab, TabStrip } from "./tab-strip";

const ADMIN_TABS: ReadonlyArray<Tab> = routesInGroup("admin").map((r) => ({
  to: r.path,
  label: r.tabLabel ?? r.label,
}));

export function AdminTabs() {
  return <TabStrip tabs={ADMIN_TABS} ariaLabel="Admin sections" />;
}
