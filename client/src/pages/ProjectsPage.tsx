import { useEffect, useMemo, useState } from "react";
import { useInvalidate } from "../useApi";
import { Link } from "react-router-dom";
import type { ProjectListItemDto, RepositoryListItem } from "@shared/api-types";
import { LOCAL_REMOTE_DISCLAIMER } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { StatusBadge, WorkingTreeBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { SourceBadge } from "../components/SourceBadge";
import { formatDateTime, relativeTime } from "../format";

type Filter =
  | "all"
  | "uncommitted"
  | "github-only"
  | "local-github"
  | "portfolio";

const CHIPS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "local-github", label: "Local + GitHub" },
  { id: "github-only", label: "GitHub only" },
  { id: "portfolio", label: "In Portfolio" },
];

/**
 * V1.1 Projects workspace: PROJECTS with explicit source composition.
 * Merges the project list (source of truth) with local-binding snapshots
 * for state columns. Dense scanning preserved at 100+ projects.
 */
export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectListItemDto[]>([]);
  const [repos, setRepos] = useState<RepositoryListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  async function loadAll() {
    const [projectData, repoData] = await Promise.all([
      client.projects(),
      client.repositories(),
    ]);
    setProjects(projectData.projects);
    setRepos(repoData.repositories);
  }

  useInvalidate(
    ["projects", "sources", "activity", "contributions"],
    async () => {
      try {
        await loadAll();
      } catch (err: unknown) {
        setError(err instanceof ApiError ? err.message : "Failed to refresh projects.");
      }
    },
  );

  useEffect(() => {
    loadAll()
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load projects.");
      })
      .finally(() => setLoaded(true));
  }, []);

  // Local snapshot lookup by project (primary binding = first repo row).
  const repoByProject = useMemo(() => {
    const map = new Map<number, RepositoryListItem>();
    for (const repo of repos) {
      if (repo.projectId != null && !map.has(repo.projectId)) {
        map.set(repo.projectId, repo);
      }
    }
    return map;
  }, [repos]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (filter === "uncommitted") {
        const repo = repoByProject.get(project.id);
        if (repo?.workingTree !== "Uncommitted") return false;
      }
      if (filter === "local-github" && project.sourceState !== "LOCAL + GITHUB") return false;
      if (filter === "github-only" && project.sourceState !== "GITHUB ONLY") return false;
      if (filter === "portfolio" && !project.includeInPortfolio) return false;
      if (!q) return true;
      const haystack =
        `${project.name} ${project.localPath ?? ""} ${project.githubFullName ?? ""} ` +
        `${project.projectStatus ?? ""} ${project.projectType ?? ""}`;
      return haystack.toLowerCase().includes(q);
    });
  }, [projects, repoByProject, filter, query]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="lede">
            {projects.length} tracked {projects.length === 1 ? "project" : "projects"} ·{" "}
            {LOCAL_REMOTE_DISCLAIMER}
          </p>
        </div>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="filters projects-filters">
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
        {/* Accessible label retained; visually hidden so the control shares
            the filter row's rhythm instead of stacking above its input.
            The field takes the toolbar's free right side at desktop width. */}
        <label className="form-field">
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, status, path, or GitHub identity"
          />
        </label>
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          message="No projects discovered yet."
          hint={<span>Add a scan location under Sources, or track a GitHub repository.</span>}
        />
      ) : visible.length === 0 ? (
        <EmptyState message="No projects match your search." />
      ) : (
        <section className="panel" style={{ padding: "6px 12px" }}>
          <table className="table projects-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Source</th>
                <th>Status</th>
                <th>Type</th>
                <th>Branch</th>
                <th>Local state</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((project) => {
                const repo = repoByProject.get(project.id);
                const isGithubOnly = project.sourceState === "GITHUB ONLY";
                const identifier = project.localPath ?? project.githubFullName ?? "";
                return (
                  <tr key={project.id}>
                    <td className="cell-project">
                      {/* Name + Project-owned Portfolio marker share one
                          line so portfolio membership no longer adds a
                          third line (and ~20px) to a row. */}
                      <div className="cell-project-head">
                        <Link className="list-link" to={`/projects/${project.id}`}>
                          {project.name}
                        </Link>
                        {project.includeInPortfolio ? (
                          <span className="pill status-experiment">Portfolio</span>
                        ) : null}
                      </div>
                      {/* Registry identity line: technical locator stays
                          secondary — one truncated line, full value on
                          hover (path = local binding, fullName = GitHub
                          binding, matching the project's source state). */}
                      <div
                        className="mono muted"
                        title={identifier}
                      >
                        {identifier}
                      </div>
                    </td>
                    <td className="cell-source">
                      <SourceBadge state={project.sourceState} />
                    </td>
                    <td className="cell-meta">
                      <StatusBadge status={project.projectStatus} />
                    </td>
                    <td className="cell-meta">
                      {project.projectType ?? <span className="muted">—</span>}
                    </td>
                    <td className="mono cell-branch" title={repo?.snapshot?.branch ?? undefined}>
                      {repo?.snapshot?.branch ?? "—"}
                    </td>
                    <td>
                      {isGithubOnly ? (
                        <span className="mono muted">n/a</span>
                      ) : (
                        <>
                          <WorkingTreeBadge isDirty={repo?.workingTree === "Uncommitted"} />
                          {repo?.snapshot &&
                          repo.snapshot.modifiedCount +
                            repo.snapshot.stagedCount +
                            repo.snapshot.untrackedCount >
                            0 ? (
                            <div className="mono muted">
                              {repo.snapshot.modifiedCount}m ·{" "}
                              {repo.snapshot.stagedCount}s ·{" "}
                              {repo.snapshot.untrackedCount}u
                            </div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="cell-activity" title={formatDateTime(project.lastMeaningfulAt)}>
                      {relativeTime(project.lastMeaningfulAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
