import { Link } from "react-router-dom";
import type { RecentlyActiveProjectDto } from "@shared/api-types";
import { StatusBadge, WorkingTreeBadge } from "./Badge";
import { EmptyState } from "./EmptyState";
import { SourceBadge } from "./SourceBadge";
import { relativeTime } from "../format";

/**
 * Compact structured project rows for Dashboard "Recently Active".
 * Source-aware (V1.1): GITHUB ONLY rows show GitHub identity instead of a
 * branch and omit local working-tree state entirely.
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
      {projects.map((project) => {
        const isGithubOnly = project.sourceState === "GITHUB ONLY";
        return (
          <div className="project-row" key={project.id}>
            <div className="project-row-main">
              <Link className="list-link" to={`/projects/${project.id}`}>
                {project.name}
              </Link>
              <span className="row-meta">
                {" "}
                <SourceBadge state={project.sourceState} /> ·{" "}
                {project.projectType ?? "No type"} ·{" "}
                <StatusBadge status={project.projectStatus} />
                {!isGithubOnly ? (
                  <>
                    {" ·"}
                    <WorkingTreeBadge isDirty={project.workingTree === "Uncommitted"} />
                  </>
                ) : null}
              </span>
              <div className="mono muted">
                {!isGithubOnly ? `${project.branch ?? "—"} · ` : ""}
                {project.latestCommitSubject ?? "no commits observed yet"}
              </div>
            </div>
            <div className="project-row-side muted">
              <div>{relativeTime(project.lastMeaningfulAt)}</div>
              <div>
                {isGithubOnly
                  ? project.githubConnected
                    ? "GitHub only"
                    : "GitHub"
                  : project.githubConnected
                    ? "Local + GitHub"
                    : "Local only"}
                {!isGithubOnly ? ` · ${project.sync}` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
