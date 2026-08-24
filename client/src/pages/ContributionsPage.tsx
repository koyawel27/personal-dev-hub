import { useState } from "react";
import { Link } from "react-router-dom";
import type { ContributionView, DailyDetailResponse } from "@shared/api-types";
import { client } from "../api";
import { ContributionCalendar } from "../components/ContributionCalendar";
import { EmptyState } from "../components/EmptyState";
import { shortSha } from "../format";
import { useApi } from "../useApi";

const VIEWS: { id: ContributionView; label: string; blurb: string }[] = [
  { id: "combined", label: "Combined", blurb: "Local + GitHub, duplicate commits collapsed" },
  { id: "local", label: "Local", blurb: "Commits discovered from local repository bindings" },
  { id: "github", label: "GitHub", blurb: "Tracked GitHub repositories only" },
];

/**
 * Contributions (V1.1): three honest views. This is NOT the user's complete
 * GitHub contribution graph — only tracked repositories' commits are shown.
 * Counts are commits, never hours.
 */
export function ContributionsPage() {
  const [view, setView] = useState<ContributionView>("combined");
  const contribution = useApi(
    () => client.contributions(view).then((data) => data.days),
    [view],
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<DailyDetailResponse | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);
  const days = contribution.data ?? [];

  async function selectDay(day: string | null): Promise<void> {
    setSelectedDay(day);
    setDayDetail(null);
    setDayError(null);
    if (!day) return;
    try {
      setDayDetail(await client.contributionDay(day, view));
    } catch {
      setDayError("Could not load detail for that day.");
    }
  }

  function switchView(next: ContributionView): void {
    setView(next);
    setSelectedDay(null);
    setDayDetail(null);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Contributions</h1>
          <p className="lede">
            Tracked commit activity across your projects — local Git observation
            and selected GitHub repositories. Counts are commits, not hours.
          </p>
        </div>
        <button type="button" onClick={() => void contribution.refetch()}>
          Refresh
        </button>
      </div>
      {contribution.error ? <div className="error">{contribution.error}</div> : null}

      <div className="filters" role="tablist">
        {VIEWS.map((option) => (
          <button
            key={option.id}
            type="button"
            title={option.blurb}
            className={`filter-chip ${view === option.id ? "active" : ""}`}
            onClick={() => switchView(option.id)}
          >
            {option.label}
            {option.id === "github" ? " (tracked)" : ""}
          </button>
        ))}
      </div>

      {contribution.loading ? (
        <p className="muted">Loading…</p>
      ) : days.length === 0 ? (
        <EmptyState
          message={
            view === "local"
              ? "No local commit activity recorded yet."
              : view === "github"
                ? "No tracked GitHub commit activity yet."
                : "No development activity recorded yet."
          }
          hint={
            <span>
              {view === "github"
                ? "Track repositories and refresh them under Sources → Browse GitHub Repositories."
                : "Commit something in a tracked project, then rescan."}
            </span>
          }
        />
      ) : (
        <>
          <section className="panel">
            <h2>
              <span className="h2-mark" aria-hidden="true" />
              This month ·{" "}
              {VIEWS.find((option) => option.id === view)?.label ?? view} source
            </h2>
            <p className="mono muted" style={{ marginTop: -4 }}>
              {VIEWS.find((option) => option.id === view)?.blurb}
            </p>
            <ContributionCalendar
              days={days}
              selectedDay={selectedDay}
              onSelectDay={(day) => void selectDay(day)}
            />
          </section>

          {selectedDay ? (
            <section className="panel">
              <h2>
                <span className="h2-mark" aria-hidden="true" />
                {selectedDay} · {dayDetail?.totalCommits ?? "…"} commit(s)
              </h2>
              {dayError ? <div className="error">{dayError}</div> : null}
              {!dayDetail ? (
                <p className="muted">Loading…</p>
              ) : dayDetail.projects.length === 0 ? (
                <EmptyState message="No recorded activity for this day." />
              ) : (
                dayDetail.projects.map((project) => (
                  <div key={project.repositoryId} style={{ marginBottom: 12 }}>
                    <Link className="list-link" to={`/projects/${project.repositoryId}`}>
                      {project.projectName}
                    </Link>
                    <ul className="day-commits">
                      {project.commits.map((commit) => (
                        <li key={commit.sha}>
                          <span className="mono">{shortSha(commit.sha)}</span> —{" "}
                          {commit.subject}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
              <p className="mono muted">
                Source:{" "}
                {view === "local"
                  ? "local git observation"
                  : view === "github"
                    ? "tracked GitHub repositories"
                    : "local + tracked GitHub (duplicates collapsed)"}
                {" · not a full GitHub profile graph"}
              </p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
