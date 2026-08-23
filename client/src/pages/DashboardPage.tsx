import { Link } from "react-router-dom";
import type { AttentionReason } from "@shared/api-types";
import { client } from "../api";
import { EmptyState } from "../components/EmptyState";
import {
  ContributionPreview,
  RescanButton,
  SectionHead,
  StatStrip,
} from "../components/DashboardParts";
import { EventFeed } from "../components/EventFeed";
import { ProjectRowList } from "../components/ProjectRow";
import {
  IconAttention,
  IconCalendar,
  IconJournal,
  IconPlus,
} from "../components/icons";
import { useApi } from "../useApi";

/**
 * Dashboard (owner review pass 1).
 *
 * Zero repositories: a deliberate onboarding panel plus compact zero
 * metrics — no four giant empty sections.
 *
 * Populated: metrics strip → Recently Active Projects (strongest block) →
 * contribution preview → Recent Activity journal beside Needs Attention.
 */
export function DashboardPage() {
  const dashboard = useApi(() => client.dashboard(), []);
  const contributions = useApi(
    () => client.contributions().then((data) => data.days),
    [],
  );

  if (dashboard.error) {
    return (
      <div>
        <header className="page-header">
          <div>
            <h1>Dashboard</h1>
            <p className="lede">What have you been building lately?</p>
          </div>
        </header>
        <div className="error">{dashboard.error}</div>
      </div>
    );
  }
  if (!data(dashboard.data)) return <Loading />;

  const d = dashboard.data;
  const days = contributions.data ?? [];
  const zero = d.trackedProjects === 0;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="lede">What have you been building lately?</p>
        </div>
        <RescanButton />
      </header>

      <StatStrip
        tracked={d.trackedProjects}
        active={d.activeProjects}
        commitsThisWeek={d.commitsThisWeek}
        activeDays={d.activeDaysThisWeek}
        uncommitted={d.uncommittedRepositories}
      />

      {zero ? (
        <Onboarding />
      ) : (
        <>
          <section className="panel">
            <SectionHead title="Recently Active Projects" count={`${String(d.recentlyActive.length)}`} />
            <ProjectRowList
              projects={d.recentlyActive}
              emptyMessage="No recent project activity yet."
            />
          </section>

          <section className="panel">
            <SectionHead icon={<IconCalendar size={13} />} title="Contribution Activity" />
            <ContributionPreview days={days} />
          </section>

          <div className="dash-columns">
            <section className="panel">
              <SectionHead icon={<IconJournal size={13} />} title="Recent Activity" />
              {d.recentActivity.length === 0 ? (
                <EmptyState message="No activity recorded yet." hint={<span>Commit something in a tracked project, then rescan.</span>} />
              ) : (
                <EventFeed events={d.recentActivity.slice(0, 8)} />
              )}
            </section>

            <section className="panel">
              <SectionHead
                icon={<IconAttention size={13} />}
                title="Needs Attention"
                count={`${String(d.needsAttention.length)}`}
              />
              {d.needsAttention.length === 0 ? (
                <EmptyState message="Nothing needs attention." />
              ) : (
                d.needsAttention.map((repo) => (
                  <div className="attention-item" key={repo.id}>
                    <Link className="list-link" to={`/projects/${repo.id}`}>
                      {repo.name}
                    </Link>
                    <div className="attention-reasons">
                      {(repo.attentionReasons ?? []).map((reason) => (
                        <AttentionChip key={reason} reason={reason as AttentionReason} />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="lede">What have you been building lately?</p>
        </div>
      </header>
      <p className="muted">Loading…</p>
    </div>
  );
}

function data(value: unknown): value is NonNullable<
  ReturnType<typeof useApi>["data"]
> & {
  trackedProjects: number;
} {
  // Narrow without importing the response type into the guard.
  return typeof value === "object" && value !== null && "trackedProjects" in value;
}

function Onboarding() {
  return (
    <div className="onboard">
      <div className="onboard-kicker">get started</div>
      <h2>Start tracking your projects</h2>
      <p>
        Point Personal Dev Hub at a folder containing Git repositories, such as{" "}
        <code>C:\xampp-projects</code> or <code>E:\Projects</code>. The hub discovers repository metadata only — it never modifies your repositories.
      </p>
      <ul className="onboard-steps">
        <li className="done">
          <span className="step-square" aria-hidden="true" />
          Add one or more source folders to scan
        </li>
        <li>
          <span className="step-square" aria-hidden="true" />
          Repositories appear under Projects with branch, state, and history
        </li>
        <li>
          <span className="step-square" aria-hidden="true" />
          Your dashboard fills with real activity — commits, branches, sync state
        </li>
      </ul>
      <div className="onboard-actions">
        <Link to="/sources" className="onboard-cta">
          <button type="button" className="primary">
            <IconPlus size={12} /> Add a source
          </button>
        </Link>
        <span className="empty-state-hint">
          Local-first · read-only Git inspection · GitHub optional
        </span>
      </div>
    </div>
  );
}

function AttentionChip({ reason }: { reason: AttentionReason }) {
  const tone = reason.includes("upstream") ? "" : " warn";
  return <span className={`pill neutral${tone}`}>{reason}</span>;
}
