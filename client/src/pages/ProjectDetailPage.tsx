import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ActivityEventDto, ProjectDetailDto } from "@shared/api-types";
import { LOCAL_REMOTE_DISCLAIMER } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { StatusBadge } from "../components/Badge";
import { MetadataEditor } from "../components/MetadataEditor";
import { SourceBadge } from "../components/SourceBadge";
import { eventLabel, formatDateTime, shortSha } from "../format";

type Tab = "overview" | "commits" | "activity";

/**
 * V1.1 Project Detail — source-aware logbook.
 *
 * The route id is a PROJECT id. LOCAL + GITHUB shows both information
 * sets; LOCAL ONLY hides the GitHub panel; GITHUB ONLY hides all local
 * state (branch/working tree/changed files) and local launcher actions.
 */
export function ProjectDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const id = Number(params.id);
  const [project, setProject] = useState<ProjectDetailDto | null>(null);
  const [bindingRepoId, setBindingRepoId] = useState<number | null>(null);
  const [bindingGhId, setBindingGhId] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityEventDto[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const detail = await client.project(id);
    setProject(detail.project);
    // Resolve registered identifiers for safe actions: the primary local
    // binding (if any) and this project's tracked GitHub binding id, which
    // the picker payload exposes directly for tracked rows.
    const repos = await client.repositories();
    const binding = repos.repositories.find(
      (repo) => repo.projectId === id && repo.id != null,
    );
    setBindingRepoId(binding?.id ?? null);
    if (detail.project.githubMetadata != null && detail.project.githubFullName != null) {
      const picker = await client.githubPicker();
      const ghBinding = picker.entries.find(
        (candidate) =>
          candidate.fullName.toLowerCase() ===
          detail.project.githubFullName!.toLowerCase(),
      );
      setBindingGhId(ghBinding?.trackedBindingId ?? null);
    } else {
      setBindingGhId(null);
    }
    const events = await client.activity({ projectId: id });
    setActivity(events.activity);
  }

  useEffect(() => {
    if (!Number.isInteger(id)) {
      setError("Project was not found.");
      return;
    }
    load().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to load project.");
    });
  }, [id]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!project && !error) return <p className="muted">Loading…</p>;
  if (!project) return <div className="error">{error}</div>;

  const isGithubOnly = project.sourceState === "GITHUB ONLY";
  const hasLocal = project.sourceState !== "GITHUB ONLY" && bindingRepoId != null;
  const snapshot = project.snapshot;

  return (
    <div>
      <div className="page-header">
        <div>
          <p className="muted">
            <Link to="/projects">Projects</Link> / {project.name}
          </p>
          <h1>{project.name}</h1>
          <p className="lede mono">{project.localPath ?? project.githubFullName}</p>
          <p className="lede">
            <SourceBadge state={project.sourceState} />
            {" · "}
            <StatusBadge status={project.projectStatus} />
            {" · "}
            {project.projectType ?? "No type"}
            {!isGithubOnly ? (
              <>
                {" · "}
                <span className="mono">{snapshot?.branch ?? "—"}</span>
                {" · "}
                {snapshot ? (snapshot.isDirty ? "Uncommitted" : "Clean") : "Not scanned"}
              </>
            ) : null}
          </p>
        </div>
        <div className="header-actions">
          {hasLocal ? (
            <>
              <button type="button" disabled={busy} onClick={() => run(() => client.open(bindingRepoId!, "folder"))}>
                Open Folder
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => client.open(bindingRepoId!, "terminal"))}>
                Open Terminal
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => client.open(bindingRepoId!, "vscode"))}>
                Open VS Code
              </button>
            </>
          ) : null}
          {project.githubHtmlUrl && bindingRepoId != null ? (
            <button type="button" disabled={busy} onClick={() => run(() => client.open(bindingRepoId, "github"))}>
              Open GitHub
            </button>
          ) : project.githubHtmlUrl ? (
            <a
              className="btn subtle"
              href={project.githubHtmlUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub ↗
            </a>
          ) : null}
          {hasLocal ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await client.refresh(bindingRepoId!);
                  await load();
                })
              }
            >
              Rescan
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}

      <div className="tabs">
        {(["overview", "commits", "activity"] as Tab[]).map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <section className="panel">
          <h2>
            <span className="h2-mark" aria-hidden="true" />
            Project metadata
          </h2>
          <MetadataEditor
            repository={{
              id: project.id,
              name: project.name,
              projectId: project.id,
              localPath: project.localPath ?? "",
              canonicalPath: project.localPath ?? "",
              discoveryType: "manual",
              sourceId: null,
              lastScannedAt: null,
              snapshot: project.snapshot,
              projectStatus: project.projectStatus,
              projectType: project.projectType,
              projectNote: project.projectNote,
              includeInPortfolio: project.includeInPortfolio,
              portfolioOrder: project.portfolioOrder,
              workingTree: project.snapshot?.isDirty ? "Uncommitted" : "Clean",
              sync: "",
              github: project.githubMetadata != null ? "GitHub Connected" : "Local Only",
              githubHtmlUrl: project.githubHtmlUrl,
              lastActivityAt: project.lastMeaningfulAt,
              lastActivitySummary: null,
              changedFiles: [],
              remotes: [],
              commits: [],
              githubMetadata: project.githubMetadata,
            }}
            onSaved={() => void load()}
            onError={(message) => setError(message)}
          />

          {!isGithubOnly ? (
            <>
              <h2>
                <span className="h2-mark" aria-hidden="true" />
                Repository state
              </h2>
              <div className="detail-grid">
                <div className="muted">Path</div>
                <div className="mono">{project.localPath}</div>
                <div className="muted">Branch</div>
                <div className="mono">{snapshot?.branch ?? "—"}</div>
                <div className="muted">HEAD</div>
                <div className="mono">{shortSha(snapshot?.headCommitSha)}</div>
                {snapshot ? (
                  <>
                    <div className="muted">Working tree</div>
                    <div>
                      <span className={`pill ${snapshot.isDirty ? "warn" : "clean"}`}>
                        {snapshot.isDirty ? "Uncommitted" : "Clean"}
                      </span>
                      {`  modified ${snapshot.modifiedCount} · staged ${snapshot.stagedCount} · untracked ${snapshot.untrackedCount}`}
                    </div>
                    <div className="muted">Sync</div>
                    <div>
                      <span className="mono muted">{LOCAL_REMOTE_DISCLAIMER}</span>
                    </div>
                  </>
                ) : (
                  <div className="muted">Scan</div>
                )}
              </div>
            </>
          ) : null}

          {project.githubMetadata ? (
            <>
              <h2>
                <span className="h2-mark" aria-hidden="true" />
                GitHub
              </h2>
              <div className="detail-grid">
                <div className="muted">Repository</div>
                <div>{project.githubMetadata.fullName}</div>
                <div className="muted">Visibility</div>
                <div>{project.githubMetadata.visibility ?? "—"}</div>
                <div className="muted">Default branch</div>
                <div className="mono">{project.githubMetadata.defaultBranch ?? "—"}</div>
                <div className="muted">Last pushed</div>
                <div>{formatDateTime(project.githubMetadata.lastPushedAt)}</div>
                <div className="muted">URL</div>
                <div>
                  <a href={project.githubMetadata.htmlUrl} target="_blank" rel="noreferrer" className="mono">
                    {project.githubMetadata.htmlUrl}
                  </a>
                </div>
              </div>
            </>
          ) : null}

          {hasLocal ? (
            <div className="header-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (!window.confirm("Remove this local copy from the dashboard? Files on disk are not deleted.")) {
                      return;
                    }
                    await client.deleteRepository(bindingRepoId!);
                    navigate("/projects");
                  })
                }
              >
                Remove local copy from dashboard
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === "commits" ? (
        <section className="panel">
          {project.commits.length === 0 ? (
            <>
              <p className="empty">
                {isGithubOnly
                  ? "No commits fetched yet for this GitHub-only project."
                  : "No recent commits."}
              </p>
              {project.githubMetadata != null && !hasLocal ? (
                <div className="header-actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || bindingGhId == null}
                    title={
                      bindingGhId == null
                        ? "Refresh this repository from Sources → Browse GitHub Repositories."
                        : "Fetch recent commits from GitHub now"
                    }
                    onClick={() =>
                      run(async () => {
                        const result = await client.refreshTrackedGithub(bindingGhId!);
                        if (!result.ok) {
                          setError("GitHub refresh failed. Tracking is unchanged; try again later.");
                        }
                        await load();
                      })
                    }
                  >
                    Refresh from GitHub
                  </button>
                  <span className="hint-text">
                    Or use Sources → Browse GitHub Repositories → Refresh.
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>SHA</th>
                  <th>Source</th>
                  <th>Subject</th>
                  <th>Author</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {project.commits.map((commit) => (
                  <tr key={`${commit.source}-${commit.sha}`}>
                    <td className="mono">{commit.shortSha}</td>
                    <td className="mono muted">{commit.source}</td>
                    <td>{commit.subject}</td>
                    <td>{commit.authorName ?? "—"}</td>
                    <td>{formatDateTime(commit.committedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {tab === "activity" ? (
        <section className="panel">
          {activity.length === 0 ? (
            <p className="empty">No activity recorded yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.occurredAt)}</td>
                    <td>{eventLabel(event.eventType)}</td>
                    <td>{event.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </div>
  );
}
