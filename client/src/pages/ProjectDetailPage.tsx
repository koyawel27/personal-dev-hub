import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInvalidate } from "../useApi";
import { notifyMutations } from "../lib/mutations";
import type { ActivityEventDto, ProjectDetailDto } from "@shared/api-types";
import { ApiError, client } from "../api";
import { removeLocalBinding } from "../lib/removeLocalBinding";
import { relinkLocalBinding } from "../lib/relinkLocalBinding";
import { StatusBadge } from "../components/Badge";
import { LocalBindingsPanel } from "../components/LocalBindingsPanel";
import { MetadataEditor } from "../components/MetadataEditor";
import { SourceBadge } from "../components/SourceBadge";
import { eventLabel, formatDateTime } from "../format";

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
  const [bindingGhId, setBindingGhId] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityEventDto[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const detail = await client.project(id);
    setProject(detail.project);
    // V1.2 M3: project.localBindings IS the authoritative binding read model.
    // The display-primary binding (for the header launcher/rescan actions)
    // comes from the server's isPrimary flag — never re-derived from
    // GET /api/repositories (no second authority, no row-order fallback).
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

  // Route safety + cross-view reconciliation: if this project is deleted
  // from elsewhere (or its bindings change in the picker), reload. When the
  // project no longer exists (404), navigate to Projects instead of showing
  // a stale/dead detail screen.
  useInvalidate(["projects", "sources", "picker", "activity"], async () => {
    if (!Number.isInteger(id)) return;
    try {
      await load();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        navigate("/projects", { replace: true });
        return;
      }
      // Keep current valid state; surface a recoverable refresh error.
      setError(err instanceof Error ? err.message : "Failed to refresh project.");
    }
  });

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

  /**
   * V1.2 M3 Add Local Copy: native folder selection first, then the
   * project-targeted attach endpoint. The server's evidence ladder may
   * answer LOCAL_BINDING_CONFIRM_REQUIRED — its summary is shown verbatim
   * and the attach retries with confirmUnverified=true only after the
   * owner accepts. Declining (or cancelling the picker) changes nothing.
   */
  async function addLocalCopy() {
    if (!project) return;
    const selection = await client.selectFolder();
    if (!selection.selected || selection.path == null) return;
    try {
      await client.addLocalBinding(project.id, selection.path);
    } catch (err: unknown) {
      if (
        !(err instanceof ApiError) ||
        err.code !== "LOCAL_BINDING_CONFIRM_REQUIRED"
      ) {
        throw err;
      }
      const attach = window.confirm(
        `${err.message}\n\nAttach this folder to "${project.name}" anyway?`,
      );
      if (!attach) return;
      await client.addLocalBinding(project.id, selection.path, true);
    }
    notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
    await load();
  }

  /**
   * V1.2 M4 Safe Relink: native folder selection first, then the
   * binding-targeted relink endpoint for the EXISTING binding id. The server's
   * evidence ladder may answer LOCAL_BINDING_RELINK_CONFIRM_REQUIRED — its
   * summary is shown verbatim and the relink retries with
   * confirmUnverified=true only after the owner accepts. A strong conflict
   * surfaces as a plain error with no override. Declining (or cancelling the
   * picker) changes nothing. On success the Project Detail reloads from the
   * server and every affected mutation channel is notified.
   */
  async function relinkCopy(bindingId: number) {
    const selection = await client.selectFolder();
    if (!selection.selected || selection.path == null) return;
    const result = await relinkLocalBinding(bindingId, selection.path);
    if (result == null) return; // owner declined the confirmation
    notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
    await load();
  }

  if (!project && !error) return <p className="muted">Loading…</p>;
  if (!project) return <div className="error">{error}</div>;

  const isGithubOnly = project.sourceState === "GITHUB ONLY";
  // V1.2 M3: header launcher/rescan actions operate on the display-primary
  // binding resolved from project.localBindings via the server's isPrimary
  // flag — the same single authority the Local Copies panel uses. No
  // array-order, name-order, or repositories-list fallback exists.
  const primaryBinding = project.localBindings.find((binding) => binding.isPrimary) ?? null;
  const hasLocal = primaryBinding != null;
  const primaryBindingId = primaryBinding?.id ?? null;
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
          {/* Identity row: the Project's source composition leads; owner
              metadata follows as quieter context. */}
          <p className="lede">
            <SourceBadge state={project.sourceState} />
            {project.projectStatus || project.projectType ? (
              <>
                {" · "}
                <span className="detail-meta">
                  {[project.projectType, project.projectStatus].filter(Boolean).join(" · ")}
                </span>
              </>
            ) : null}
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
              <button type="button" disabled={busy} onClick={() => run(() => client.open(primaryBindingId!, "folder"))}>
                Open Folder
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => client.open(primaryBindingId!, "terminal"))}>
                Open Terminal
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => client.open(primaryBindingId!, "vscode"))}>
                Open VS Code
              </button>
            </>
          ) : null}
          {project.githubHtmlUrl && primaryBindingId != null ? (
            <button type="button" disabled={busy} onClick={() => run(() => client.open(primaryBindingId, "github"))}>
              Open GitHub
            </button>
          ) : project.githubHtmlUrl ? (
            /* External open action for GitHub-only projects: rendered as a
               real link-button (a.btn) so it reads as intentionally
               interactive next to its button siblings. */
            <a
              className="btn"
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
                  await client.refresh(primaryBindingId!);
                  await load();
                })
              }
            >
              Rescan
            </button>
          ) : null}
          {/* Source management: secondary, restrained. Registered binding id
              only; the backend Q1 guard handles keep-or-delete safety. */}
          {project.githubMetadata != null && bindingGhId != null ? (
            isGithubOnly ? (
              <button
                type="button"
                className="btn subtle danger"
                disabled={busy}
                title="Stop tracking this repository in Personal Dev Hub. The real GitHub repository is never modified."
                onClick={() =>
                  run(async () => {
                    const result = await client.untrackGithub(bindingGhId!);
                    if (result.projectDeleted) {
                      // Reconcile every view, then leave the dead route.
                      notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
                      navigate("/projects", { replace: true });
                      return;
                    }
                    notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
                    await load();
                  })
                }
              >
                Untrack GitHub
              </button>
            ) : (
              <button
                type="button"
                className="btn subtle danger"
                disabled={busy}
                title="Remove the GitHub binding from Personal Dev Hub. The project stays LOCAL ONLY; nothing on disk or on GitHub is touched."
                onClick={() =>
                  run(async () => {
                    await client.untrackGithub(bindingGhId!);
                    notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
                    await load();
                  })
                }
              >
                Disconnect GitHub
              </button>
            )
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
            {/* Owner-managed domain marker: this form edits the PROJECT,
                never a binding. */}
            <span className="domain-tag mono">project data</span>
          </h2>
          <MetadataEditor
            repository={{
              id: project.id,
              name: project.name,
              projectId: project.id,
              isPrimary: false,
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
            onSaved={() => {
              notifyMutations("projects", "dashboard", "portfolio", "activity", "sources");
              void load();
            }}
            onError={(message) => setError(message)}
          />

          <h2>
            <span className="h2-mark" aria-hidden="true" />
            Local copies
            <span className="domain-tag mono">local bindings</span>
          </h2>
          {/* V1.2 M3: every local binding from the server-authoritative
              Project Detail read model — one row per copy with its own
              health/snapshot, per-binding safe actions, and the native
              Add Local Copy flow. Renders for all source states. */}
          <LocalBindingsPanel
            bindings={project.localBindings ?? []}
            busy={busy}
            onAdd={() => run(addLocalCopy)}
            onOpen={(bindingId, action) => run(() => client.open(bindingId, action))}
            onRescan={(bindingId) =>
              run(async () => {
                await client.refresh(bindingId);
                await load();
              })
            }
            onRelink={(bindingId) => run(() => relinkCopy(bindingId))}
            onMakePrimary={(bindingId) =>
              run(async () => {
                // Display-primary flip: pure preference change (no Git, no
                // filesystem, no activity event). Server order is the only
                // authority for the refreshed binding list.
                await client.setLocalPrimary(bindingId);
                notifyMutations("projects", "sources", "dashboard", "portfolio");
                await load();
              })
            }
            onRemove={(bindingId) =>
              run(async () => {
                if (!window.confirm("Remove this local copy from the dashboard? Files on disk are not deleted.")) {
                  return;
                }
                const result = await removeLocalBinding(bindingId);
                // Reconcile every view first; if the project auto-deleted,
                // this route no longer exists and we leave it cleanly.
                notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
                if (result.projectDeleted) {
                  navigate("/projects", { replace: true });
                  return;
                }
                await load();
              })
            }
          />

          {project.githubMetadata ? (
            <>
              <h2>
                <span className="h2-mark" aria-hidden="true" />
                GitHub
                <span className="domain-tag mono">github source</span>
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
