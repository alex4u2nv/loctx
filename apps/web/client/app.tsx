import { lazy, Suspense, useCallback, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { ConfirmHost } from "./components/confirm";
import { LiveRefresh } from "./components/live-refresh";

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
const SearchPage = lazy(() =>
  import("./routes/search").then((m) => ({ default: m.SearchPage })),
);
const FindUsagesPage = lazy(() =>
  import("./routes/find-usages").then((m) => ({ default: m.FindUsagesPage })),
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

const ROUTE_FALLBACK = <p className="pullquote">Loading…</p>;

export function App() {
  // Force a child remount when the watcher SSE fires so the page
  // re-fetches its data without a router round-trip.
  const [tick, setTick] = useState(0);
  const onEvent = useCallback(() => setTick((t) => t + 1), []);

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
          <NavLink to="/doctor">doctor</NavLink>
          <NavLink to="/models">models</NavLink>
          <NavLink to="/config">config</NavLink>
          <NavLink to="/admin">admin</NavLink>
        </nav>
        <span className="nav-meta">
          <LiveRefresh onEvent={onEvent} />
          <span>
            mcp <code>/mcp</code>
          </span>
        </span>
      </header>
      <main>
        <Suspense fallback={ROUTE_FALLBACK}>
          <Routes>
            <Route path="/" element={<StatusPage refreshKey={tick} />} />
            <Route path="/projects" element={<ProjectsPage refreshKey={tick} />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/find-usages" element={<FindUsagesPage />} />
            <Route path="/doctor" element={<DoctorPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </Suspense>
      </main>
      <ConfirmHost />
    </BrowserRouter>
  );
}
