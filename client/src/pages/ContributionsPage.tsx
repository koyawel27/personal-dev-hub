import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ContributionView, DailyDetailResponse } from "@shared/api-types";
import { client } from "../api";
import { ContributionCalendar } from "../components/ContributionCalendar";
import { EmptyState } from "../components/EmptyState";
import { shortSha } from "../format";
import { useApi } from "../useApi";

const VIEWS: { id: ContributionView; label: string; blurb: string }[] = [
  { id: "combined", label: "COMBINED", blurb: "Union of local + GitHub; overlapping commits counted once" },
  { id: "local", label: "LOCAL", blurb: "Unique commits observed from tracked local repository bindings" },
  { id: "github", label: "GITHUB", blurb: "Unique commits fetched from selected tracked GitHub repositories" },
];

/**
 * Contributions — year activity view. Tracked commits only (local Git
 * observation + selected tracked GitHub repositories); this is not a
 * reproduction of GitHub's full contribution model. Counts are commits,
 * never hours.
 */
export function ContributionsPage() {
  const yearsApi = useApi(() => client.contributionYears(), [], {
    invalidateOn: ["contributions"],
  });
  const [view, setView] = useState<ContributionView>("combined");
  const [year, setYear] = useState<number | null>(null);

  const activeYear = year ?? yearsApi.data?.years[0] ?? new Date().getFullYear();
  const contribution = useApi(
    () => client.contributionYear(activeYear, view),
    [activeYear, view],
    { invalidateOn: ["contributions", "activity"] },
  );

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<DailyDetailResponse | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);
  /** Heading anchor for the selected-day detail panel (focus target). */
  const dayDetailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  /** Cell that opened the detail panel — focus returns there on deselect. */
  const lastCalendarCellRef = useRef<HTMLElement | null>(null);
  const days = contribution.data?.days ?? [];
  const totals = contribution.data?.totals;

  async function selectDay(day: string | null, source?: Element): Promise<void> {
    if (source instanceof HTMLElement) lastCalendarCellRef.current = source;
    setSelectedDay(day);
    setDayDetail(null);
    setDayError(null);
    if (!day) {
      // Deselect: hand focus back to the calendar cell that opened it.
      lastCalendarCellRef.current?.focus();
      return;
    }
    try {
      setDayDetail(await client.contributionDay(day, view));
      // One logical keyboard exit from the grid: focus moves to the detail
      // heading so the commit list is immediately reachable. The heading
      // carries tabindex="-1" so this does not add a tab stop.
      requestAnimationFrame(() => dayDetailHeadingRef.current?.focus());
    } catch {
      setDayError("Could not load detail for that day.");
    }
  }

  function switchView(next: ContributionView): void {
    setView(next);
    setSelectedDay(null);
    setDayDetail(null);
  }

  const dedup = contribution.data?.dedup;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Contributions</h1>
          <p className="lede">
            Tracked commits across your projects — local Git observation and
            selected GitHub repositories. Counts are commits, not hours.
          </p>
        </div>
        <button type="button" onClick={() => void contribution.refetch()}>
          Refresh
        </button>
      </div>
      {contribution.error ? (
        <div className="error" role="alert">
          {contribution.error}
        </div>
      ) : null}

      <div className="contrib-controls">
        <div className="filters" role="tablist" aria-label="Contribution source">
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={view === option.id}
              title={option.blurb}
              className={`filter-chip ${view === option.id ? "active" : ""}`}
              onClick={() => switchView(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {yearsApi.data && yearsApi.data.years.length > 1 ? (
          <label className="year-select">
            <span className="micro-label">Year</span>
            <select
              value={activeYear}
              onChange={(event) => {
                setYear(Number(event.target.value));
                setSelectedDay(null);
                setDayDetail(null);
              }}
            >
              {yearsApi.data.years.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {contribution.loading || yearsApi.loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {totals != null ? (
            <div className="contrib-stats" aria-label="Tracked commit statistics">
              <div className="stat">
                <span className="stat-num mono">{totals.commits}</span>
                <span className="stat-label">tracked commits</span>
              </div>
              <div className="stat">
                <span className="stat-num mono">{totals.activeDays}</span>
                <span className="stat-label">active days</span>
              </div>
              <div className="stat">
                <span className="stat-num mono">{totals.projects}</span>
                <span className="stat-label">projects</span>
              </div>
            </div>
          ) : null}

          {dedup != null ? (
            <p className="dedup-note mono muted">
              Local observed {dedup.localObserved} · GitHub observed{" "}
              {dedup.githubObserved} · overlap {dedup.overlap} collapsed ·{" "}
              <strong>combined unique {dedup.combinedUnique}</strong>
            </p>
          ) : null}

          {days.length === 0 ? (
            <EmptyState
              message={
                view === "local"
                  ? `No tracked local commits in ${activeYear}.`
                  : view === "github"
                    ? `No tracked GitHub commits in ${activeYear}.`
                    : `No tracked commits in ${activeYear}.`
              }
              hint={
                <span>
                  {view === "github"
                    ? "Track repositories and refresh them under Sources → Browse GitHub Repositories."
                    : "Switch source or year, or commit something in a tracked project."}
                </span>
              }
            />
          ) : (
            <section className="panel">
              <h2>
                <span className="h2-mark" aria-hidden="true" />
                {activeYear} ·{" "}
                {VIEWS.find((option) => option.id === view)?.label ?? view} tracked
                commits
              </h2>
              <p className="mono muted" style={{ marginTop: -4 }}>
                {VIEWS.find((option) => option.id === view)?.blurb}
              </p>
              <ContributionCalendar
                year={activeYear}
                days={days}
                selectedDay={selectedDay}
                onSelectDay={(day) => void selectDay(day)}
              />
            </section>
          )}

          {selectedDay ? (
            <section className="panel" aria-live="polite">
              <h2 ref={dayDetailHeadingRef} tabIndex={-1}>
                <span className="h2-mark" aria-hidden="true" />
                {formatDayHeading(selectedDay)} ·{" "}
                {dayDetail ? `${dayDetail.totalCommits} unique commit(s)` : "…"}
                {dayDetail ? ` across ${dayDetail.projects.length} project(s)` : ""}
              </h2>
              {dayError ? (
                <div className="error" role="alert">
                  {dayError}
                </div>
              ) : null}
              {!dayDetail ? (
                <p className="muted">Loading…</p>
              ) : dayDetail.projects.length === 0 ? (
                <EmptyState message="No recorded activity for this day." />
              ) : (
                dayDetail.projects.map((project) => (
                  <div key={project.repositoryId} style={{ marginBottom: 14 }}>
                    <div className="day-project-head">
                      {/* DailyProjectCommits.repositoryId carries the owning
                          PROJECT id (see ContributionService.dailyDetail),
                          so this route is already project-identity-safe. */}
                      <Link
                        className="list-link"
                        to={`/projects/${project.repositoryId}`}
                        title={`Open project #${project.repositoryId}`}
                      >
                        {project.projectName}
                      </Link>
                      <span className={`pill neutral${project.source === "LOCAL + GITHUB" ? "" : ""}`}>
                        {project.source}
                      </span>
                      <span className="mono muted">{project.commits.length} commit(s)</span>
                    </div>
                    <ul className="day-commits">
                      {project.commits.map((commit) => (
                        <li key={`${commit.sha}-${String(commit.source)}`}>
                          <span className="mono">{shortSha(commit.sha)}</span> —{" "}
                          {commit.subject}
                          <span className="mono muted">
                            {" "}
                            · {commit.source}
                            {commit.committedAt
                              ? ` · ${new Date(commit.committedAt).toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
              <p className="mono muted">
                Source lens:{" "}
                {view === "local"
                  ? "LOCAL — local git observation"
                  : view === "github"
                    ? "GITHUB — tracked GitHub repositories"
                    : "COMBINED — duplicates counted once"}
                {" · tracked commits only, not a full GitHub profile graph"}
              </p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function formatDayHeading(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
