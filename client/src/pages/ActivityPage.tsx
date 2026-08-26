import { useEffect, useState } from "react";
import type { ActivityEventDto, ProjectListItemDto } from "@shared/api-types";
import { ApiError, client } from "../api";
import { EventFeed } from "../components/EventFeed";
import { EmptyState } from "../components/EmptyState";
import { useInvalidate } from "../useApi";

const PAGE_SIZE = 50;

/**
 * Activity page (owner UX pass).
 *
 * State model:
 * - draftProject / draftFrom / draftTo: what the controls show.
 * - appliedProject / appliedFrom / appliedTo: what the feed queries.
 *
 * Project selection applies IMMEDIATELY (with the previously APPLIED date
 * range — unsubmitted date edits stay drafts). Date changes require the
 * explicit Filter button. Pagination is cursor-based over the LOGICAL
 * (commit-deduplicated) feed; "Load more" appends the next batch.
 */
export function ActivityPage() {
  const [events, setEvents] = useState<ActivityEventDto[]>([]);
  // Activity is PROJECT-centric: the selector lists every Project
  // (LOCAL ONLY, LOCAL + GITHUB, GITHUB ONLY) with Project ids as values.
  const [projects, setProjects] = useState<ProjectListItemDto[]>([]);

  // Draft control state.
  const [draftProject, setDraftProject] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  // Applied query state.
  const [appliedProject, setAppliedProject] = useState("");
  const [appliedFrom, setAppliedFrom] = useState("");
  const [appliedTo, setAppliedTo] = useState("");

  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreFailed, setLoadingMoreFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function rangeParams(from: string, to: string): { from?: string; to?: string } {
    return {
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
    };
  }

  async function loadFirstPage(project: string, from: string, to: string) {
    const result = await client.activityPage({
      projectId: project ? Number(project) : undefined,
      ...rangeParams(from, to),
      limit: PAGE_SIZE,
    });
    setEvents(result.rows);
    setCursor(result.nextCursor);
    setHasMore(result.nextCursor != null);
    setLoadingMoreFailed(false);
  }

  async function loadProjects() {
    const data = await client.projects();
    setProjects(data.projects);
  }

  useEffect(() => {
    Promise.all([
      client.activityPage({ limit: PAGE_SIZE }),
      client.projects(),
    ])
      .then(([page, projectData]) => {
        setEvents(page.rows);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor != null);
        setProjects(projectData.projects);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load activity.");
      });
  }, []);

  // Project selection applies immediately: refetch page 1 with the
  // APPLIED date range (drafts are untouched), resetting pagination.
  function onProjectChange(value: string): void {
    setDraftProject(value);
    if (value === appliedProject) return;
    setAppliedProject(value);
    setError(null);
    loadFirstPage(value, appliedFrom, appliedTo).catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to apply project filter.");
    });
  }

  // Dates remain explicit: only Filter commits the drafts.
  function onFilterSubmit(): void {
    setError(null);
    setAppliedProject(draftProject);
    setAppliedFrom(draftFrom);
    setAppliedTo(draftTo);
    loadFirstPage(draftProject, draftFrom, draftTo)
      .then(() => void loadProjects().catch(() => undefined))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to apply filters.");
      });
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || cursor == null) return;
    setLoadingMore(true);
    try {
      const result = await client.activityPage({
        projectId: appliedProject ? Number(appliedProject) : undefined,
        ...rangeParams(appliedFrom, appliedTo),
        cursor,
        limit: PAGE_SIZE,
      });
      setEvents((previous) => {
        const seen = new Set(previous.map((row) => `${row.occurredAt}|${row.id}`));
        return [...previous, ...result.rows.filter((row) => !seen.has(`${row.occurredAt}|${row.id}`))];
      });
      setCursor(result.nextCursor);
      setHasMore(result.nextCursor != null);
      setLoadingMoreFailed(false);
    } catch {
      // Keep existing rows visible; offer retry.
      setLoadingMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  useInvalidate(["activity", "projects", "sources"], () => {
    // Reconcile from the first page of the currently APPLIED filter state.
    setError(null);
    loadFirstPage(appliedProject, appliedFrom, appliedTo).catch(() => undefined);
    void loadProjects().catch(() => undefined);
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Activity</h1>
          <p className="lede">Meaningful state changes across tracked projects.</p>
        </div>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      <form
        className="form-row"
        onSubmit={(event) => {
          event.preventDefault();
          onFilterSubmit();
        }}
      >
        <label className="form-field">
          <span>Project</span>
          <select value={draftProject} onChange={(event) => onProjectChange(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={String(project.id)}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>From</span>
          <input type="date" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} />
        </label>
        <label className="form-field">
          <span>To</span>
          <input type="date" value={draftTo} onChange={(event) => setDraftTo(event.target.value)} />
        </label>
        <button type="submit" className="primary">
          Filter
        </button>
      </form>
      {events.length === 0 && !error ? (
        <EmptyState
          message={
            appliedProject
              ? "No activity matches these filters for this project yet."
              : "No activity matches these filters."
          }
          hint={<span>Adjust the filters, rescan a tracked project, or commit something in one.</span>}
        />
      ) : (
        <section className="panel">
          <EventFeed events={events} />
          {hasMore ? (
            <div className="load-more-row">
              {loadingMoreFailed ? (
                <span className="mono muted">Could not load older activity.</span>
              ) : null}
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : events.length > 0 ? (
            <p className="mono muted load-more-end">End of activity for these filters.</p>
          ) : null}
        </section>
      )}
    </div>
  );
}
