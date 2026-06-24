/**
 * Admin hub tabs — groups the workspace-wide operations + diagnostics
 * pages (operations, config, models, doctor, logs) into one surface, the
 * same way the Search Explorer groups the search modes. Routes stay
 * separate; the active tab tracks the current location.
 */

import { type Tab, TabStrip } from "./tab-strip";

const ADMIN_TABS: ReadonlyArray<Tab> = [
  { to: "/admin", label: "Admin" },
  { to: "/config", label: "Config" },
  { to: "/analyzers", label: "Analyzers" },
  { to: "/models", label: "Models" },
  { to: "/doctor", label: "Doctor" },
  { to: "/logs", label: "Logs" },
];

export function AdminTabs() {
  return <TabStrip tabs={ADMIN_TABS} ariaLabel="Admin sections" />;
}
