import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ConfirmHost } from "./components/confirm";
import { Icon, type IconName } from "./components/icon";
import { LiveRefresh } from "./components/live-refresh";
import { McpHelpModal } from "./components/mcp-help";
import { NotificationsBell } from "./components/notifications-bell";
import { api } from "./lib/api";
import { type ColorMode, getMode, toggleMode } from "./lib/appearance";
import { type RouteGroup, routeLabelFor, routesInGroup } from "./lib/routes";
import { initScrollReveal } from "./lib/scroll-reveal";
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
const DuplicatesPage = lazy(() =>
  import("./routes/duplicates").then((m) => ({ default: m.DuplicatesPage })),
);
const DoctorPage = lazy(() => import("./routes/doctor").then((m) => ({ default: m.DoctorPage })));
const ModelsPage = lazy(() => import("./routes/models").then((m) => ({ default: m.ModelsPage })));
const ConfigPage = lazy(() => import("./routes/config").then((m) => ({ default: m.ConfigPage })));
const AnalyzersPage = lazy(() =>
  import("./routes/analyzers").then((m) => ({ default: m.AnalyzersPage })),
);
const AdminPage = lazy(() => import("./routes/admin").then((m) => ({ default: m.AdminPage })));
const LogsPage = lazy(() => import("./routes/logs").then((m) => ({ default: m.LogsPage })));

const ROUTE_FALLBACK = <p className="pullquote">Loading…</p>;

// Sidebar groups: heading + group icon; the items themselves come from
// the shared route table (lib/routes.ts, audit WEB-9).
const NAV_GROUPS: ReadonlyArray<{
  readonly heading: string;
  readonly icon: IconName;
  readonly group: RouteGroup;
}> = [
  { heading: "Menu", icon: "home", group: "menu" },
  { heading: "Search", icon: "search", group: "search" },
  { heading: "Admin", icon: "admin", group: "admin" },
];

export function App() {
  const [mcpHelpOpen, setMcpHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // Scroll reveal for section cards across every route. Set up
  // once against the content <main>; the controller's MutationObserver picks
  // up lazily-mounted route content on its own (see lib/scroll-reveal).
  useEffect(() => {
    const main = document.querySelector("main");
    return main === null ? undefined : initScrollReveal(main);
  }, []);
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

        <div className="min-w-0 bg-[var(--nav-bg)] lg:ml-[290px]">
          <Header onMenu={() => setNavOpen((v) => !v)} onMcp={() => setMcpHelpOpen(true)} />
          {/* Content panel: a distinct --bg surface that tucks into the
              header+sidebar frame with a rounded top-left inner corner,
              matching the rounded cards inside it. */}
          <div
            className="min-h-[calc(100vh-4rem)] rounded-tl-2xl border-l border-t bg-[var(--bg)]"
            style={{ borderColor: "var(--border)" }}
          >
            <main>
              <AnimatedRoutes />
            </main>
          </div>
        </div>
      </div>
      <ConfirmHost />
      {mcpHelpOpen ? <McpHelpModal onClose={() => setMcpHelpOpen(false)} /> : null}
    </BrowserRouter>
  );
}

/**
 * Routes wrapped in a per-pathname keyed container so the `.page-transition`
 * animation replays on every navigation (the div remounts when the key
 * changes). `location` is threaded into <Routes> so it resolves against the
 * same pathname the key is derived from. Lives inside <BrowserRouter> so
 * `useLocation` has router context.
 */
function AnimatedRoutes() {
  const location = useLocation();
  return (
    <div key={location.pathname} className="page-transition">
      <Suspense fallback={ROUTE_FALLBACK}>
        <Routes location={location}>
          <Route path="/" element={<StatusPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/find-usages" element={<FindUsagesPage />} />
          <Route path="/find-literal" element={<FindLiteralPage />} />
          <Route path="/duplicates" element={<DuplicatesPage />} />
          <Route path="/doctor" element={<DoctorPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/analyzers" element={<AnalyzersPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </Suspense>
    </div>
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

/** Fixed left rail — the app shell's primary navigation. */
function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { collapsed, toggle } = useCollapsedGroups();
  return (
    <aside
      className={`fixed left-0 top-0 z-40 flex h-screen w-[290px] flex-col bg-[var(--nav-bg)] transition-transform duration-200 lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-16 items-center gap-2.5 px-6">
        <img src="/logo.png" alt="loctx" className="h-9 w-9 rounded-lg" />
        <span className="text-lg font-semibold tracking-tight text-[var(--text)]">loctx</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-4 py-2">
        {NAV_GROUPS.map((group) => {
          const isCollapsed = collapsed[group.heading] === true;
          return (
            <div key={group.heading} className="mb-4">
              <button
                type="button"
                onClick={() => toggle(group.heading)}
                aria-expanded={!isCollapsed}
                className="mb-1 flex w-full items-center justify-between rounded-md px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wider text-[var(--subtle)] transition-colors hover:text-[var(--text)]"
              >
                <span className="flex items-center gap-2">
                  <span className="text-[0.8rem]">
                    <Icon name={group.icon} />
                  </span>
                  {group.heading}
                </span>
                <span
                  className={`text-[0.7rem] transition-transform duration-200 ${
                    isCollapsed ? "-rotate-90" : ""
                  }`}
                >
                  <Icon name="chevron-down" />
                </span>
              </button>
              {isCollapsed ? null : (
                <ul className="flex flex-col gap-1">
                  {routesInGroup(group.group).map((item) => (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
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
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 bg-[var(--nav-bg)] px-4 lg:px-6">
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
  // A breadcrumb-style label, deliberately NOT a heading — each route
  // renders its own <h1>, so a second heading here would duplicate the
  // document title (a11y) and break heading-based selectors.
  return (
    <div className="truncate text-base font-semibold text-[var(--text)]" aria-hidden="true">
      {routeLabelFor(pathname) ?? "Dashboard"}
    </div>
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
