import { NavLink, Outlet } from "react-router-dom";
import {
  BrandMark,
  IconActivity,
  IconContributions,
  IconDashboard,
  IconMaintenance,
  IconPortfolio,
  IconProjects,
  IconSettings,
  IconSources,
} from "../components/icons";

const primary = [
  { to: "/", label: "Dashboard", end: true, Icon: IconDashboard },
  { to: "/projects", label: "Projects", Icon: IconProjects },
  { to: "/activity", label: "Activity", Icon: IconActivity },
  { to: "/contributions", label: "Contributions", Icon: IconContributions },
  { to: "/portfolio", label: "Portfolio", Icon: IconPortfolio },
];

const utility = [
  { to: "/sources", label: "Sources", Icon: IconSources },
  { to: "/maintenance", label: "Maintenance", Icon: IconMaintenance },
  { to: "/settings", label: "Settings", Icon: IconSettings },
];

/**
 * Desktop workspace sidebar (owner review pass 1): fixed-width deliberate
 * navigation column. Vertical nav, icons secondary to labels, active item
 * marked with a surface lift + left accent bar + square indicator.
 */
export function AppShell() {
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <span className="brand-name">Personal Dev Hub</span>
            <span className="brand-sub">local-first · single-user</span>
          </div>
        </div>

        <nav className="nav" aria-label="Primary">
          <div className="nav-label">Workspace</div>
          <ul className="nav-list">
            {primary.map(({ to, label, end, Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="nav-label">Manage</div>
          <ul className="nav-list">
            {utility.map(({ to, label, Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-foot mono">read-only git · v1</div>
      </aside>
      {/* tabindex="-1": lets fragment navigation move real focus here so
          the next Tab press starts from the page content. */}
      <main className="main" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
