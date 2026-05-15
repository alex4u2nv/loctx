import { useCallback, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { ConfirmHost } from "./components/confirm";
import { LiveRefresh } from "./components/live-refresh";
import { AdminPage } from "./routes/admin";
import { ConfigPage } from "./routes/config";
import { DoctorPage } from "./routes/doctor";
import { FindUsagesPage } from "./routes/find-usages";
import { ModelsPage } from "./routes/models";
import { ProjectsPage } from "./routes/projects";
import { SearchPage } from "./routes/search";
import { StatusPage } from "./routes/status";

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
      </main>
      <ConfirmHost />
    </BrowserRouter>
  );
}
