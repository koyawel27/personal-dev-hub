import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ActivityEventDto, RepositoryDetail } from "@shared/api-types";
import { LOCAL_REMOTE_DISCLAIMER } from "@shared/status-terms";
import { ApiError, client } from "../api";
import { eventLabel, formatDateTime, shortSha } from "../format";

type Tab = "overview" | "commits" | "activity";

export function ProjectDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const id = Number(params.id);
  const [repo, setRepo] = useState<RepositoryDetail | null>(null);
  const [activity, setActivity] = useState<ActivityEventDto[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const detail = await client.repository(id);
    setRepo(detail.repository);
    const events = await client.activity({ repositoryId: id });
    setActivity(events.activity);
  }

  useEffect(() => {
    if (!Number.isInteger(id)) {
      setError("Repository was not found.");
      return;
    }
    load().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to load repository.");
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

  if (!repo && !error) return <p className="muted">Loading…</p>;
  if (!repo) return <div className="error">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <p className="muted">
            <Link to="/projects">Projects</Link> / {repo.name}
          </p>
          <h1>{repo.name}</h1>
          <p className="lede mono">{repo.localPath}</p>
        </div>
        <div className="header-actions">
          <button type="button" disabled={busy} onClick={() => run(() => client.open(repo.id, "folder"))}>
            Open Folder
          </button>
          <button type="button" disabled={busy} onClick={() => run(() => client.open(repo.id, "terminal"))}>
            Open Terminal
          </button>
          <button type="button" disabled={busy} onClick={() => run(() => client.open(repo.id, "vscode"))}>
            Open VS Code
          </button>
          {repo.githubHtmlUrl ? (
            <button type="button" disabled={busy} onClick={() => run(() => client.open(repo.id, "github"))}>
              Open GitHub
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const refreshed = await client.refresh(repo.id);
                setRepo(refreshed.repository);
                const events = await client.activity({ repositoryId: repo.id });
                setActivity(events.activity);
              })
            }
          >
            Rescan
          </button>
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
          <div className="detail-grid">
            <div className="muted">Path</div>
            <div className="mono">{repo.localPath}</div>
            <div className="muted">Branch</div>
            <div className="mono">{repo.snapshot?.branch ?? "—"}</div>
            <div className="muted">HEAD</div>
            <div className="mono">{shortSha(repo.snapshot?.headCommitSha)}</div>
            <div className="muted">Working tree</div>
            <div>
              <span className={`pill ${repo.workingTree === "Clean" ? "clean" : "warn"}`}>
                {repo.workingTree}
              </span>
              {`  modified ${repo.snapshot?.modifiedCount ?? 0} · staged ${repo.snapshot?.stagedCount ?? 0} · untracked ${repo.snapshot?.untrackedCount ?? 0}`}
            </div>
            <div className="muted">Sync</div>
            <div>
              {repo.sync}
              <div className="muted">{LOCAL_REMOTE_DISCLAIMER}</div>
            </div>
            <div className="muted">Last scan</div>
            <div>{formatDateTime(repo.lastScannedAt)}</div>
            <div className="muted">GitHub</div>
            <div>{repo.github}</div>
          </div>

          <h2>Changed files</h2>
          {repo.changedFiles.length === 0 ? (
            <p className="empty">No changed files.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Kind</th>
                  <th>Index</th>
                  <th>Work tree</th>
                </tr>
              </thead>
              <tbody>
                {repo.changedFiles.map((file) => (
                  <tr key={file.path}>
                    <td className="mono">{file.path}</td>
                    <td>{file.kind}</td>
                    <td className="mono">{file.indexStatus}</td>
                    <td className="mono">{file.workTreeStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Remotes</h2>
          {repo.remotes.length === 0 ? (
            <p className="empty">No remotes configured.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Host</th>
                </tr>
              </thead>
              <tbody>
                {repo.remotes.map((remote) => (
                  <tr key={remote.name}>
                    <td className="mono">{remote.name}</td>
                    <td className="mono">{remote.url}</td>
                    <td>{remote.isGitHub ? "GitHub Connected" : remote.host || "Local Only"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {repo.githubMetadata ? (
            <>
              <h2>GitHub metadata</h2>
              <div className="detail-grid">
                <div className="muted">Repository</div>
                <div>{repo.githubMetadata.fullName}</div>
                <div className="muted">Visibility</div>
                <div>{repo.githubMetadata.visibility ?? "—"}</div>
                <div className="muted">Default branch</div>
                <div className="mono">{repo.githubMetadata.defaultBranch ?? "—"}</div>
                <div className="muted">Last pushed</div>
                <div>{formatDateTime(repo.githubMetadata.lastPushedAt)}</div>
              </div>
            </>
          ) : null}

          <div className="header-actions" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!window.confirm("Remove this repository from the dashboard? Files on disk are not deleted.")) {
                    return;
                  }
                  await client.deleteRepository(repo.id);
                  navigate("/projects");
                })
              }
            >
              Remove from dashboard
            </button>
          </div>
        </section>
      ) : null}

      {tab === "commits" ? (
        <section className="panel">
          {repo.commits.length === 0 ? (
            <p className="empty">No recent commits.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>SHA</th>
                  <th>Subject</th>
                  <th>Author</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {repo.commits.map((commit) => (
                  <tr key={commit.sha}>
                    <td className="mono">{commit.shortSha}</td>
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
