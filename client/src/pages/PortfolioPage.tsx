import { Link } from "react-router-dom";
import type { PortfolioItemDto } from "@shared/api-types";
import { client } from "../api";
import { notifyMutations } from "../lib/mutations";
import { Badge, StatusBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { formatDateTime } from "../format";
import { useApi } from "../useApi";

/**
 * Lightweight selected-work view (plan 8.3): generated from tracked
 * project data — never a portfolio-builder workflow. Ordering uses the
 * same metadata PATCH primitive the detail editor uses.
 */
export function PortfolioPage() {
  const portfolio = useApi(
    () => client.portfolio().then((data) => data.projects),
    [],
    { invalidateOn: ["portfolio", "projects"] },
  );
  const projects = portfolio.data ?? [];

  async function reorder(item: PortfolioItemDto, direction: -1 | 1) {
    const ordered = projects.filter((entry) => entry.portfolioOrder != null);
    const index = ordered.findIndex((entry) => entry.id === item.id);
    const target = ordered[index + direction];
    if (!target) return;
    // Portfolio membership belongs to PROJECTS: mutate through project
    // identity so GITHUB ONLY items work identically to local ones.
    await client.updateProjectMetadata(item.id, { portfolioOrder: target.portfolioOrder });
    await client.updateProjectMetadata(target.id, { portfolioOrder: item.portfolioOrder });
    notifyMutations("portfolio", "projects");
    await portfolio.refetch();
  }

  async function removeFromPortfolio(item: PortfolioItemDto) {
    await client.updateProjectMetadata(item.id, { includeInPortfolio: false });
    notifyMutations("portfolio", "projects", "dashboard");
    await portfolio.refetch();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Portfolio</h1>
          <p className="lede">Selected work from your tracked projects.</p>
        </div>
      </div>
      {portfolio.error ? <div className="error">{portfolio.error}</div> : null}
      {portfolio.loading ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          message="No projects selected for your portfolio."
          hint={<span>Open a project and switch “Include in Portfolio” on.</span>}
        />
      ) : (
        <section className="panel">
          {projects.map((item, index) => {
            const orderedCount = projects.filter((entry) => entry.portfolioOrder != null).length;
            return (
              <div className="portfolio-item" key={item.id}>
                <div className="portfolio-main">
                  <Link className="list-link" to={`/projects/${item.id}`}>
                    {item.name}
                  </Link>
                  <span className="row-meta">
                    {" "}
                    {item.projectType ?? "No type"} ·{" "}
                    <StatusBadge status={item.projectStatus} />
                  </span>
                  {item.projectNote ? <p>{item.projectNote}</p> : null}
                  <div className="mono muted">
                    {item.technologyHints.length > 0 ? item.technologyHints.join(" · ") : ""}
                  </div>
                  <div className="muted">
                    {item.firstCommitAt
                      ? `Active ${formatDateTime(item.firstCommitAt)} → ${formatDateTime(item.latestCommitAt)}`
                      : "No recorded commit dates yet."}
                  </div>
                </div>
                <div className="portfolio-side">
                  {item.githubHtmlUrl ? (
                    <Badge tone="neutral">GitHub</Badge>
                  ) : (
                    <Badge tone="neutral">Local only</Badge>
                  )}
                  <div className="row-actions">
                    <button
                      type="button"
                      aria-label={`Move ${item.name} up`}
                      disabled={index === 0}
                      onClick={() => void reorder(item, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${item.name} down`}
                      disabled={index >= orderedCount - 1}
                      onClick={() => void reorder(item, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void removeFromPortfolio(item)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
