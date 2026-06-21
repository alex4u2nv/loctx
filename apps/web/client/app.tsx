import { lazy, Suspense, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { AppearanceMenu } from "./components/appearance-menu";
import { ConfirmHost } from "./components/confirm";
import { LiveRefresh } from "./components/live-refresh";
import { McpHelpModal } from "./components/mcp-help";
import { NotificationsBell } from "./components/notifications-bell";

// Route-level code splitting (#218). Each page chunk loads on first
// navigation rather than ship in the initial bundle. The status page
// is the dashboard / "/" route so we eager-load it — it's the most
// common landing target and lazy-loading the first paint creates a
// visible flicker. The others (search, find-usages, doctor, models,
// config, admin) each get their own chunk; navigating to one fetches
// it on demand and the result stays cached for the rest of the
// session.
import { StatusPage } from "./routes/status";

const ProjectsPage = lazy(() =>
  import("./routes/projects").then((m) => ({ default: m.ProjectsPage })),
);
const ProjectDetailPage = lazy(() =>
  import("./routes/project-detail").then((m) => ({ default: m.ProjectDetailPage })),
);
const SearchPage = lazy(() =>
  import("./routes/search").then((m) => ({ default: m.SearchPage })),
);
const FindUsagesPage = lazy(() =>
  import("./routes/find-usages").then((m) => ({ default: m.FindUsagesPage })),
);
const FindLiteralPage = lazy(() =>
  import("./routes/find-literal").then((m) => ({ default: m.FindLiteralPage })),
);
const DoctorPage = lazy(() =>
  import("./routes/doctor").then((m) => ({ default: m.DoctorPage })),
);
const ModelsPage = lazy(() =>
  import("./routes/models").then((m) => ({ default: m.ModelsPage })),
);
const ConfigPage = lazy(() =>
  import("./routes/config").then((m) => ({ default: m.ConfigPage })),
);
const AdminPage = lazy(() =>
  import("./routes/admin").then((m) => ({ default: m.AdminPage })),
);
const LogsPage = lazy(() =>
  import("./routes/logs").then((m) => ({ default: m.LogsPage })),
);

const ROUTE_FALLBACK = <p className="pullquote">Loading…</p>;

export function App() {
  // SSE subscription lives inside the routes that actually want
  // refresh-on-event (StatusPage + ProjectsPage), via
  // `useLiveRefreshEvent` from components/live-refresh. App no longer
  // owns a `tick` prop — that pattern interrupted React Router v7's
  // navigation transitions during reconciliation (#249).
  const [mcpHelpOpen, setMcpHelpOpen] = useState(false);
  return (
    <BrowserRouter>
      <header className="nav">
        <span className="nav-brand">loctx</span>
        <nav className="nav-links">
          <NavLink to="/" end>
            dashboard
          </NavLink>
          <NavLink to="/projects">projects</NavLink>
          <NavLink to="/search">search</NavLink>
          <NavLink to="/find-usages">find-usages</NavLink>
          <NavLink to="/find-literal">find-literal</NavLink>
          <NavLink to="/doctor">doctor</NavLink>
          <NavLink to="/models">models</NavLink>
          <NavLink to="/config">config</NavLink>
          <NavLink to="/logs">logs</NavLink>
          <NavLink to="/admin">admin</NavLink>
        </nav>
        <span className="nav-meta">
          <AppearanceMenu />
          <LiveRefresh />
          <NotificationsBell />
          <button
            type="button"
            className="nav-mcp"
            onClick={() => setMcpHelpOpen(true)}
            title="Show MCP client setup snippets"
          >
            mcp <code>/mcp</code>
          </button>
        </span>
      </header>
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
      <ConfirmHost />
      {mcpHelpOpen ? <McpHelpModal onClose={() => setMcpHelpOpen(false)} /> : null}
    </BrowserRouter>
  );
}
