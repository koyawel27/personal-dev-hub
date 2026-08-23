import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardResponse } from "@shared/api-types";
import { EMPTY_STATES, LOCAL_REMOTE_DISCLAIMER } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { eventLabel, formatDateTime } from "../format";

export function DashboardPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .dashboard()
      .then(setData)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load dashboard.");
      });
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="lede">Local Git repositories on this computer.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="label">Tracked Projects</div>
              <div className="value">{data.trackedProjects}</div>
            </div>
            <div className="stat-card">
              <div className="label">Uncommitted Projects</div>
              <div className="value">{data.uncommittedProjects}</div>
            </div>
            <div className="stat-card">
              <div className="label">Active This Week</div>
              <div className="value">{data.activeThisWeek}</div>
            </div>
            <div className="stat-card">
              <div className="label">Commits This Week</div>
              <div className="value">{data.commitsThisWeek}</div>
            </div>
          </div>

          <section className="panel">
            <h2>Needs Attention</h2>
            {data.needsAttention.length === 0 ? (
              <p className="empty">{EMPTY_STATES.noAttention}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Working tree</th>
                    <th>Sync</th>
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
                      <td>
                        <span className={`pill ${repo.workingTree === "Clean" ? "clean" : "warn"}`}>
                          {repo.workingTree}
                        </span>
                      </td>
                      <td>
                        {repo.sync}
                        <div className="muted">{LOCAL_REMOTE_DISCLAIMER}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2>Recent Projects</h2>
            {data.recentProjects.length === 0 ? (
              <p className="empty">{EMPTY_STATES.noProjects}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Branch</th>
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentProjects.map((repo) => (
                    <tr key={repo.id}>
                      <td>
                        <Link className="list-link" to={`/projects/${repo.id}`}>
                          {repo.name}
                        </Link>
                      </td>
                      <td className="mono">{repo.snapshot?.branch ?? "—"}</td>
                      <td>{formatDateTime(repo.lastActivityAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2>Recent Activity</h2>
            {data.recentActivity.length === 0 ? (
              <p className="empty">{EMPTY_STATES.noActivity}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Project</th>
                    <th>Type</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentActivity.map((event) => (
                    <tr key={event.id}>
                      <td>{formatDateTime(event.occurredAt)}</td>
                      <td>
                        <Link to={`/projects/${event.localRepositoryId}`}>{event.projectName}</Link>
                      </td>
                      <td>{eventLabel(event.eventType)}</td>
                      <td>{event.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
