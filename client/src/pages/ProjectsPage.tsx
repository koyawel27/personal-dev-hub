import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { RepositoryListItem } from "@shared/api-types";
import { LOCAL_REMOTE_DISCLAIMER } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { StatusBadge, WorkingTreeBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { formatDateTime, relativeTime } from "../format";

type Filter =
  | "all"
  | "uncommitted"
  | "ahead"
  | "behind"
  | "github"
  | "local"
  | "portfolio";

const CHIPS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "ahead", label: "Ahead" },
  { id: "behind", label: "Behind" },
  { id: "github", label: "GitHub" },
  { id: "local", label: "Local Only" },
  { id: "portfolio", label: "In Portfolio" },
];

/**
 * Dense workspace table per plan section 8.3: must stay scannable at
 * 10 / 30 / 100+ repositories. Sans for names; mono for paths, branches,
 * and SHAs.
 */
export function ProjectsPage() {
  const [repos, setRepos] = useState<RepositoryListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    client
      .repositories()
      .then((data) => setRepos(data.repositories))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load projects.");
      })
      .finally(() => setLoaded(true));
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((repo) => {
      if (filter === "uncommitted" && repo.workingTree !== "Uncommitted") return false;
      if (filter === "ahead" && !((repo.snapshot?.aheadCount ?? 0) > 0)) return false;
      if (filter === "behind" && !((repo.snapshot?.behindCount ?? 0) > 0)) return false;
      if (filter === "github" && !repo.githubHtmlUrl) return false;
      if (filter === "local" && repo.githubHtmlUrl) return false;
      if (filter === "portfolio" && !repo.includeInPortfolio) return false;
      if (!q) return true;
      return (
        repo.name.toLowerCase().includes(q) ||
        (repo.projectStatus ?? "").toLowerCase().includes(q) ||
        (repo.projectType ?? "").toLowerCase().includes(q) ||
        repo.localPath.toLowerCase().includes(q) ||
        (repo.snapshot?.branch ?? "").toLowerCase().includes(q)
      );
    });
  }, [repos, filter, query]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="lede">
            {repos.length} tracked {repos.length === 1 ? "project" : "projects"} ·{" "}
            {LOCAL_REMOTE_DISCLAIMER}
          </p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="filters">
        {CHIPS.map((chip) => (
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
          placeholder="Search name, status, path, or branch"
        />
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : repos.length === 0 ? (
        <EmptyState message="No projects discovered yet." hint={<span>Add a scan location under Sources.</span>} />
      ) : visible.length === 0 ? (
        <EmptyState message="No projects match your search." />
      ) : (
        <section className="panel" style={{ padding: "6px 12px" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Status</th>
                <th>Type</th>
                <th>Branch</th>
                <th>State</th>
                <th>Sync</th>
                <th>Source</th>
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
                    <div className="mono muted">{repo.localPath}</div>
                    {repo.includeInPortfolio ? (
                      <span className="pill status-experiment">Portfolio</span>
                    ) : null}
                  </td>
                  <td>
                    <StatusBadge status={repo.projectStatus} />
                  </td>
                  <td>{repo.projectType ?? <span className="muted">—</span>}</td>
                  <td className="mono">{repo.snapshot?.branch ?? "—"}</td>
                  <td>
                    <WorkingTreeBadge isDirty={repo.workingTree === "Uncommitted"} />
                    {repo.snapshot && repo.snapshot.modifiedCount + repo.snapshot.stagedCount + repo.snapshot.untrackedCount > 0 ? (
                      <div className="mono muted">
                        {repo.snapshot.modifiedCount}m · {repo.snapshot.stagedCount}s · {repo.snapshot.untrackedCount}u
                      </div>
                    ) : null}
                  </td>
                  <td title={LOCAL_REMOTE_DISCLAIMER}>{repo.sync}</td>
                  <td>{repo.githubHtmlUrl ? "GitHub" : "Local"}</td>
                  <td title={formatDateTime(repo.lastActivityAt)}>
                    {relativeTime(repo.lastActivityAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
