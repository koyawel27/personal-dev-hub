import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { RepositoryListItem } from "@shared/api-types";
import { EMPTY_STATES, LOCAL_REMOTE_DISCLAIMER } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { formatDateTime } from "../format";

type Filter = "all" | "uncommitted" | "ahead" | "behind" | "github" | "local";

export function ProjectsPage() {
  const [repos, setRepos] = useState<RepositoryListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    client
      .repositories()
      .then((data) => setRepos(data.repositories))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load projects.");
      });
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((repo) => {
      if (filter === "uncommitted" && repo.workingTree !== "Uncommitted") return false;
      if (filter === "ahead" && !(repo.snapshot?.aheadCount && repo.snapshot.aheadCount > 0)) {
        return false;
      }
      if (filter === "behind" && !(repo.snapshot?.behindCount && repo.snapshot.behindCount > 0)) {
        return false;
      }
      if (filter === "github" && repo.github !== "GitHub Connected") return false;
      if (filter === "local" && repo.github !== "Local Only") return false;
      if (!q) return true;
      return (
        repo.name.toLowerCase().includes(q) ||
        repo.localPath.toLowerCase().includes(q) ||
        (repo.snapshot?.branch ?? "").toLowerCase().includes(q)
      );
    });
  }, [repos, filter, query]);

  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "uncommitted", label: "Uncommitted" },
    { id: "ahead", label: "Ahead" },
    { id: "behind", label: "Behind" },
    { id: "github", label: "GitHub" },
    { id: "local", label: "Local Only" },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="lede">Tracked local Git repositories.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="filters">
        {chips.map((chip) => (
          <button
            key={chip.id}
            className={`filter-chip ${filter === chip.id ? "active" : ""}`}
            onClick={() => setFilter(chip.id)}
            type="button"
          >
            {chip.label}
          </button>
        ))}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, path, or branch"
        />
      </div>
      {repos.length === 0 ? (
        <p className="empty">{EMPTY_STATES.noProjects}</p>
      ) : visible.length === 0 ? (
        <p className="empty">{EMPTY_STATES.noSearchMatch}</p>
      ) : (
        <section className="panel">
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Path</th>
                <th>Branch</th>
                <th>Working tree</th>
                <th>Sync</th>
                <th>GitHub</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((repo) => (
                <tr key={repo.id}>
                  <td>
                    <Link className="list-link" to={`/projects/${repo.id}`}>
                      {repo.name}
                    </Link>
                  </td>
                  <td className="mono">{repo.localPath}</td>
                  <td className="mono">{repo.snapshot?.branch ?? "—"}</td>
                  <td>
                    <span className={`pill ${repo.workingTree === "Clean" ? "clean" : "warn"}`}>
                      {repo.workingTree}
                    </span>
                  </td>
                  <td title={LOCAL_REMOTE_DISCLAIMER}>{repo.sync}</td>
                  <td>{repo.github}</td>
                  <td>{formatDateTime(repo.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{LOCAL_REMOTE_DISCLAIMER}</p>
        </section>
      )}
    </div>
  );
}
