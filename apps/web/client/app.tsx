import { lazy, Suspense, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ConfirmHost } from "./components/confirm";
import { Icon, type IconName } from "./components/icon";
import { LiveRefresh } from "./components/live-refresh";
import { McpHelpModal } from "./components/mcp-help";
import { NotificationsBell } from "./components/notifications-bell";
import { api } from "./lib/api";
import { type ColorMode, getMode, toggleMode } from "./lib/appearance";
import { useFetch } from "./lib/use-fetch";

// Route-level code splitting (#218). Each page chunk loads on first
// navigation rather than ship in the initial bundle. The status page
// is the dashboard / "/" route so we eager-load it — it's the most
// common landing target and lazy-loading the first paint creates a
// visible flicker.
import { StatusPage } from "./routes/status";

const ProjectsPage = lazy(() =>
  import("./routes/projects").then((m) => ({ default: m.ProjectsPage })),
);
const ProjectDetailPage = lazy(() =>
  import("./routes/project-detail").then((m) => ({ default: m.ProjectDetailPage })),
);
const SearchPage = lazy(() => import("./routes/search").then((m) => ({ default: m.SearchPage })));
const FindUsagesPage = lazy(() =>
  import("./routes/find-usages").then((m) => ({ default: m.FindUsagesPage })),
);
const FindLiteralPage = lazy(() =>
  import("./routes/find-literal").then((m) => ({ default: m.FindLiteralPage })),
);
const DoctorPage = lazy(() => import("./routes/doctor").then((m) => ({ default: m.DoctorPage })));
const ModelsPage = lazy(() => import("./routes/models").then((m) => ({ default: m.ModelsPage })));
const ConfigPage = lazy(() => import("./routes/config").then((m) => ({ default: m.ConfigPage })));
const AdminPage = lazy(() => import("./routes/admin").then((m) => ({ default: m.AdminPage })));
const LogsPage = lazy(() => import("./routes/logs").then((m) => ({ default: m.LogsPage })));

const ROUTE_FALLBACK = <p className="pullquote">Loading…</p>;

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  readonly end?: boolean;
}
interface NavGroup {
  readonly heading?: string;
  readonly items: ReadonlyArray<NavItem>;
}

const NAV: ReadonlyArray<NavGroup> = [
  {
    heading: "Menu",
    items: [
      { to: "/", label: "Dashboard", icon: "dashboard", end: true },
      { to: "/projects", label: "Projects", icon: "projects" },
    ],
  },
  {
    heading: "Search",
    items: [
      { to: "/search", label: "Search", icon: "search" },
      { to: "/find-usages", label: "Find usages", icon: "usages" },
      { to: "/find-literal", label: "Find literal", icon: "literal" },
    ],
  },
  {
    heading: "Admin",
    items: [
      { to: "/admin", label: "Admin", icon: "admin" },
      { to: "/config", label: "Config", icon: "config" },
      { to: "/models", label: "Models", icon: "models" },
      { to: "/doctor", label: "Doctor", icon: "doctor" },
      { to: "/logs", label: "Logs", icon: "logs" },
    ],
  },
];

const ROUTE_LABELS: ReadonlyArray<{ readonly prefix: string; readonly label: string }> = [
  { prefix: "/projects", label: "Projects" },
  { prefix: "/search", label: "Search" },
  { prefix: "/find-usages", label: "Find usages" },
  { prefix: "/find-literal", label: "Find literal" },
  { prefix: "/doctor", label: "Doctor" },
  { prefix: "/models", label: "Models" },
  { prefix: "/config", label: "Config" },
  { prefix: "/logs", label: "Logs" },
  { prefix: "/admin", label: "Admin" },
];

export function App() {
  const [mcpHelpOpen, setMcpHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  return (
    <BrowserRouter>
      <div className="min-h-screen">
        <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
        {/* Mobile scrim */}
        {navOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-30 bg-gray-900/40 lg:hidden"
          />
        ) : null}

        <div className="min-w-0 lg:ml-[290px]">
          <Header onMenu={() => setNavOpen((v) => !v)} onMcp={() => setMcpHelpOpen(true)} />
          <main>
            <Suspense fallback={ROUTE_FALLBACK}>
              <Routes>
                <Route path="/" element={<StatusPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/projects/:id" element={<ProjectDetailPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/find-usages" element={<FindUsagesPage />} />
                <Route path="/find-literal" element={<FindLiteralPage />} />
                <Route path="/doctor" element={<DoctorPage />} />
                <Route path="/models" element={<ModelsPage />} />
                <Route path="/config" element={<ConfigPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/admin" element={<AdminPage />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
      <ConfirmHost />
      {mcpHelpOpen ? <McpHelpModal onClose={() => setMcpHelpOpen(false)} /> : null}
    </BrowserRouter>
  );
}

const NAV_COLLAPSE_KEY = "loctx.nav.collapsed";

/** Per-group collapse state, persisted so a folded section stays folded. */
function useCollapsedGroups(): {
  collapsed: Record<string, boolean>;
  toggle: (heading: string) => void;
} {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const toggle = (heading: string): void =>
    setCollapsed((prev) => {
      const next = { ...prev, [heading]: !prev[heading] };
      try {
        localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // storage disabled — collapse still works for the session
      }
      return next;
    });
  return { collapsed, toggle };
}

/** Fixed left rail — TailAdmin's signature chrome. */
function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { collapsed, toggle } = useCollapsedGroups();
  return (
    <aside
      className={`fixed left-0 top-0 z-40 flex h-screen w-[290px] flex-col border-r bg-[var(--nav-bg)] transition-transform duration-200 lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex h-16 items-center gap-2.5 px-6">
        <img src="/logo.png" alt="loctx" className="h-9 w-9 rounded-lg" />
        <span className="text-lg font-semibold tracking-tight text-[var(--text)]">loctx</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-4 py-2">
        {NAV.map((group) => {
          const heading = group.heading ?? "main";
          const isCollapsed = group.heading !== undefined && collapsed[group.heading] === true;
          return (
            <div key={heading} className="mb-4">
              {group.heading ? (
                <button
                  type="button"
                  onClick={() => toggle(group.heading as string)}
                  aria-expanded={!isCollapsed}
                  className="mb-1 flex w-full items-center justify-between rounded-md px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wider text-[var(--subtle)] transition-colors hover:text-[var(--text)]"
                >
                  {group.heading}
                  <span
                    className={`text-[0.7rem] transition-transform duration-200 ${
                      isCollapsed ? "-rotate-90" : ""
                    }`}
                  >
                    <Icon name="chevron-down" />
                  </span>
                </button>
              ) : null}
              {isCollapsed ? null : (
                <ul className="flex flex-col gap-1">
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end === true}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                            isActive
                              ? "bg-[var(--primary-soft)] text-[var(--primary)]"
                              : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                          }`
                        }
                      >
                        <span className="w-5 text-center text-base">
                          <Icon name={item.icon} />
                        </span>
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function Header({ onMenu, onMcp }: { onMenu: () => void; onMcp: () => void }) {
  return (
    <header
      className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-[var(--nav-bg)] px-4 lg:px-6"
      style={{ borderColor: "var(--border)" }}
    >
      <button
        type="button"
        aria-label="Toggle menu"
        onClick={onMenu}
        className="flex h-9 w-9 items-center justify-center rounded-lg border text-[var(--muted)] hover:text-[var(--text)] lg:hidden"
        style={{ borderColor: "var(--border)" }}
      >
        <Icon name="menu" />
      </button>
      <PageTitle />
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <StatusChip />
        <ThemeToggle />
        <LiveRefresh />
        <NotificationsBell />
        <button
          type="button"
          onClick={onMcp}
          title="Show MCP client setup snippets"
          className="hidden items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] sm:inline-flex"
          style={{ borderColor: "var(--border)" }}
        >
          mcp <code className="text-[var(--primary)]">/mcp</code>
        </button>
      </div>
    </header>
  );
}

/** Current section name as the header title. */
function PageTitle() {
  const { pathname } = useLocation();
  const match = ROUTE_LABELS.find(
    (r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`),
  );
  return (
    <h1 className="truncate text-base font-semibold text-[var(--text)]">
      {match?.label ?? "Dashboard"}
    </h1>
  );
}

function ThemeToggle() {
  const [mode, setMode] = useState<ColorMode>(() => getMode());
  return (
    <button
      type="button"
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={mode === "dark" ? "Light mode" : "Dark mode"}
      onClick={() => setMode(toggleMode())}
      className="flex h-9 w-9 items-center justify-center rounded-full border text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      style={{ borderColor: "var(--border)" }}
    >
      <Icon name={mode === "dark" ? "sun" : "moon"} />
    </button>
  );
}

/** Compact daemon liveness + port indicator. */
function StatusChip() {
  const { data } = useFetch(() => api.status(), []);
  if (data === undefined || data === null) return null;
  const running = data.daemon.running;
  const port = running ? data.daemon.port : null;
  return (
    <span
      className={`status-chip ${running ? "ok" : "bad"}`}
      title={running ? `Daemon running on port ${port}` : "Daemon not running"}
    >
      <span className="status-dot" />
      {running && port !== null ? <code>:{port}</code> : "offline"}
    </span>
  );
}
