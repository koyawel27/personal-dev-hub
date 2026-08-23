import { NavLink, Outlet } from "react-router-dom";

const primary = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/projects", label: "Projects" },
  { to: "/activity", label: "Activity" },
  { to: "/contributions", label: "Contributions" },
  { to: "/portfolio", label: "Portfolio" },
];

const utility = [
  { to: "/sources", label: "Sources" },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Personal Dev Hub
        </div>
        <div className="brand-sub">local-first · single-user</div>
        <nav className="nav">
          <div className="nav-group">
            {primary.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) => (isActive ? "active" : undefined)}
              >
                {link.label}
              </NavLink>
            ))}
          </div>
          <div className="nav-group">
            <div className="nav-label">Workspace</div>
            {utility.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) => (isActive ? "active" : undefined)}
              >
                {link.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
