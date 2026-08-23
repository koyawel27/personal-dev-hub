import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ActivityEventDto, RepositoryListItem } from "@shared/api-types";
import { EMPTY_STATES } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { eventLabel, formatDateTime } from "../format";

export function ActivityPage() {
  const [events, setEvents] = useState<ActivityEventDto[]>([]);
  const [repos, setRepos] = useState<RepositoryListItem[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load(next?: { repositoryId?: string; from?: string; to?: string }) {
    const repo = next?.repositoryId ?? repositoryId;
    const fromValue = next?.from ?? from;
    const toValue = next?.to ?? to;
    const data = await client.activity({
      repositoryId: repo ? Number(repo) : undefined,
      from: fromValue ? new Date(fromValue).toISOString() : undefined,
      to: toValue ? new Date(`${toValue}T23:59:59`).toISOString() : undefined,
    });
    setEvents(data.activity);
  }

  useEffect(() => {
    Promise.all([client.activity(), client.repositories()])
      .then(([activity, repositories]) => {
        setEvents(activity.activity);
        setRepos(repositories.repositories);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load activity.");
      });
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Activity</h1>
          <p className="lede">Meaningful state changes across tracked repositories.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <form
        className="form-row"
        onSubmit={(event) => {
          event.preventDefault();
          load().catch((err: unknown) => {
            setError(err instanceof ApiError ? err.message : "Failed to load activity.");
          });
        }}
      >
        <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
          <option value="">All projects</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.name}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <button type="submit" className="primary">
          Filter
        </button>
      </form>
      {events.length === 0 ? (
        <p className="empty">{EMPTY_STATES.noActivity}</p>
      ) : (
        <section className="panel">
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
              {events.map((event) => (
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
        </section>
      )}
    </div>
  );
}
