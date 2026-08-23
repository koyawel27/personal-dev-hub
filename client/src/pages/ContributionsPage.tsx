import { useState } from "react";
import { Link } from "react-router-dom";
import type { DailyDetailResponse } from "@shared/api-types";
import { client } from "../api";
import { ContributionCalendar } from "../components/ContributionCalendar";
import { EmptyState } from "../components/EmptyState";
import { shortSha } from "../format";
import { useApi } from "../useApi";

/**
 * First-class contributions view (plan section 8.3): original warm-scale
 * calendar, day drill-down grouped per project, source labels always
 * explicit. Counts are commits — never hours.
 */
export function ContributionsPage() {
  const contribution = useApi(
    () => client.contributions().then((data) => data.days),
    [],
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
      setDayDetail(await client.contributionDay(day));
    } catch {
      setDayError("Could not load detail for that day.");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Contributions</h1>
          <p className="lede">
            Local commit activity across your projects. Counts are commits, not
            hours.
          </p>
        </div>
        <button type="button" onClick={() => void contribution.refetch()}>
          Refresh
        </button>
      </div>
      {contribution.error ? <div className="error">{contribution.error}</div> : null}
      {contribution.loading ? (
        <p className="muted">Loading…</p>
      ) : days.length === 0 ? (
        <EmptyState
          message="No development activity recorded yet."
          hint={<span>Commit something in a tracked project, then refresh.</span>}
        />
      ) : (
        <>
          <section className="panel">
            <h2>
              <span className="h2-mark" aria-hidden="true" />
              This month · Local source
            </h2>
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
              <p className="mono muted">Source: local git observation</p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
