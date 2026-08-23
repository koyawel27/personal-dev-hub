import { Link } from "react-router-dom";
import type { RecentlyActiveProjectDto } from "@shared/api-types";
import { StatusBadge, WorkingTreeBadge } from "./Badge";
import { EmptyState } from "./EmptyState";
import { relativeTime, shortSha } from "../format";

/**
 * Compact structured project rows for Dashboard "Recently Active" (plan 8.3).
 * Priority metadata: name, status/type, last meaningful activity, latest
 * commit, branch, clean state. Secondary: GitHub/local, ahead/behind.
 */
export function ProjectRowList({
  projects,
  emptyMessage,
}: {
  projects: RecentlyActiveProjectDto[];
  emptyMessage: string;
}) {
  if (projects.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }
  return (
    <div className="project-rows">
      {projects.map((project) => (
        <div className="project-row" key={project.id}>
          <div className="project-row-main">
            <Link className="list-link" to={`/projects/${project.id}`}>
              {project.name}
            </Link>
            <span className="row-meta">
              {" "}
              {project.projectType ?? "No type"} ·{" "}
              <StatusBadge status={project.projectStatus} /> ·{" "}
              <WorkingTreeBadge isDirty={project.workingTree === "Uncommitted"} />
            </span>
            <div className="mono muted">
              {project.branch ?? "—"}
              {project.latestCommitSubject ? ` · ${project.latestCommitSubject}` : ""}
            </div>
          </div>
          <div className="project-row-side muted">
            <div>{relativeTime(project.lastMeaningfulAt)}</div>
            <div>
              {project.githubConnected ? "GitHub" : "Local only"} · {project.sync}
            </div>
            <div className="mono">{shortSha(project.branch ?? null)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
