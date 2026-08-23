import { useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api";
import { EmptyState } from "../components/EmptyState";
import { EventFeed } from "../components/EventFeed";
import { ProjectRowList } from "../components/ProjectRow";
import { useApi } from "../useApi";

/**
 * Dashboard per approved plan section 8.3 — primary question:
 * "What have I been building lately?" Visual priority, top to bottom:
 * 1 compact metrics · 2 Recently Active Projects · 3 contribution preview ·
 * 4 Recent Activity · 5 Needs Attention (secondary).
 */
export function DashboardPage() {
  const dashboard = useApi(() => client.dashboard(), []);
  const contributions = useApi(
    () => client.contributions().then((data) => data.days),
    [],
  );
  const data = dashboard.data;
  const days = contributions.data ?? [];
  const activeDays = new Set(days.map((day) => day.date)).size;

  if (dashboard.error) {
    return (
      <div>
        <PageHeader />
        <div className="error">{dashboard.error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <PageHeader />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const last14 = days.slice(-14);
  const totalCommits14 = last14.reduce((sum, day) => sum + day.total, 0);

  return (
    <div>
      <PageHeader />

      {/* 1. compact summary metrics */}
      <div className="stat-grid">
        <StatTile label="Tracked Projects" value={data.trackedProjects} />
        <StatTile label="Active Projects" value={data.activeProjects} />
        <StatTile label="Commits This Week" value={data.commitsThisWeek} />
        <StatTile label="Active Days This Week" value={data.activeDaysThisWeek} />
        <StatTile label="Uncommitted Repositories" value={data.uncommittedRepositories} />
      </div>

      {/* 2. recently active projects */}
      <section className="panel">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Recently Active Projects
        </h2>
        <ProjectRowList
          projects={data.recentlyActive}
          emptyMessage="No projects tracked yet."
        />
      </section>

      {/* 3. contribution preview */}
      <section className="panel">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Contribution preview
        </h2>
        {days.length === 0 ? (
          <EmptyState
            message="No development activity recorded yet."
            hint={<Link to="/contributions">Open Contributions</Link>}
          />
        ) : (
          <div className="calendar-preview">
            <div className="preview-strip" aria-hidden="true">
              {last14.map((day) => (
                <span
                  key={day.date}
                  className={`cell l${day.total === 1 ? 1 : day.total <= 3 ? 2 : 3}`}
                  title={`${day.date}: ${day.total} commit(s)`}
                />
              ))}
            </div>
            <p className="mono muted">
              Last {last14.length} active days · {totalCommits14} commits ·{" "}
              {activeDays > 0 ? `${activeDays} active days on record` : ""}
            </p>
            <Link to="/contributions">Full contribution history →</Link>
          </div>
        )}
      </section>

      {/* 4. recent activity */}
      <section className="panel">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Recent Activity
        </h2>
        {data.recentActivity.length === 0 ? (
          <EmptyState message="No activity recorded yet." />
        ) : (
          <EventFeed events={data.recentActivity} />
        )}
      </section>

      {/* 5. needs attention (secondary) */}
      <section className="panel">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Needs Attention
        </h2>
        {data.needsAttention.length === 0 ? (
          <EmptyState message="No projects need attention." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Reasons</th>
                <th>Branch</th>
              </tr>
            </thead>
            <tbody>
              {data.needsAttention.map((repo) => (
                <tr key={repo.id}>
                  <td>
                    <Link className="list-link" to={`/projects/${repo.id}`}>
                      {repo.name}
                    </Link>
                  </td>
                  <td>{(repo.attentionReasons ?? []).join(" · ")}</td>
                  <td className="mono">{repo.branch ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function PageHeader() {
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function rescanAll() {
    setScanning(true);
    setNotice(null);
    try {
      const result = await client.scanAll();
      setNotice(
        `Scanned ${result.summary.sourcesScanned} source(s): ${result.summary.repositoriesDiscovered} discovered, ${result.summary.repositoriesRefreshed} refreshed.`,
      );
    } catch {
      setNotice("Rescan failed.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="page-header">
      <div>
        <h1>Dashboard</h1>
        <p className="lede">What have you been building lately?</p>
      </div>
      <div>
        {notice ? <p className="mono muted">{notice}</p> : null}
        <button type="button" disabled={scanning} onClick={() => void rescanAll()}>
          {scanning ? "Scanning…" : "Rescan all sources"}
        </button>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
