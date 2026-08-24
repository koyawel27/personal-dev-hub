import { useState } from "react";
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
  const [reorderBusyId, setReorderBusyId] = useState<number | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const raw = portfolio.data ?? [];

  /**
   * ONE canonical ordered collection used for rendering, button disabled
   * states, AND reorder target resolution. The backend already returns
   * portfolio_order ASC with un-ordered items appended by name; deriving a
   * separate filtered list here previously desynchronized the handler from
   * what the owner sees (items without an explicit order silently
   * no-op'ed their move buttons).
   */
  const projects = [...raw].sort((a, b) => {
    const ao = a.portfolioOrder;
    const bo = b.portfolioOrder;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null) return -1;
    if (bo != null) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  async function reorder(item: PortfolioItemDto, direction: -1 | 1): Promise<void> {
    // Resolve neighbors from THE SAME collection that is rendered.
    const index = projects.findIndex((entry) => entry.id === item.id);
    if (index === -1) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= projects.length) return;
    const target = projects[targetIndex];
    if (!target || target.id === item.id) return;

    // Swap order values using Project identity. If the second update fails,
    // refetch so the UI shows real server state instead of pretending the
    // swap completed.
    setReorderBusyId(item.id);
    try {
      await client.updateProjectMetadata(item.id, {
        portfolioOrder: target.portfolioOrder ?? maxOrder(projects) + 1,
      });
      await client.updateProjectMetadata(target.id, {
        portfolioOrder: item.portfolioOrder ?? maxOrder(projects) + 1,
      });
      notifyMutations("portfolio", "projects");
      await portfolio.refetch();
    } catch {
      await portfolio.refetch().catch(() => undefined); // show true state
      throw new Error("Reorder failed — the displayed order is unchanged.");
    } finally {
      setReorderBusyId(null);
    }
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
      {reorderError ? (
        <div className="error" role="alert">
          {reorderError}
        </div>
      ) : null}
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
                      disabled={index === 0 || reorderBusyId != null}
                      onClick={() =>
                        void reorder(item, -1).catch((err: unknown) => {
                          setReorderError(err instanceof Error ? err.message : "Reorder failed.");
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${item.name} down`}
                      disabled={index >= projects.length - 1 || reorderBusyId != null}
                      onClick={() =>
                        void reorder(item, 1).catch((err: unknown) => {
                          setReorderError(err instanceof Error ? err.message : "Reorder failed.");
                        })
                      }
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={reorderBusyId != null}
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

/** Highest explicit portfolioOrder in the collection (fallback slot). */
function maxOrder(items: PortfolioItemDto[]): number {
  let max = 0;
  for (const item of items) {
    if (item.portfolioOrder != null && item.portfolioOrder > max) {
      max = item.portfolioOrder;
    }
  }
  return max;
}
