import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubStatusDto, PickerEntryDto } from "@shared/api-types";
import { ApiError, client } from "../api";
import { notifyMutations } from "../lib/mutations";
import { useApi } from "../useApi";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "owned", label: "Owned" },
  { key: "collaborator", label: "Collaborator" },
  { key: "org", label: "Organization" },
  { key: "public", label: "Public" },
  { key: "private", label: "Private" },
  { key: "archived", label: "Archived" },
  { key: "forks", label: "Forks" },
  { key: "tracked", label: "Tracked" },
  { key: "untracked", label: "Untracked" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function unavailableMessage(
  status: GitHubStatusDto | null,
): { title: string; detail: string } {
  if (status != null && !status.installed) {
    return {
      title: "GitHub CLI not available",
      detail:
        "Install GitHub CLI when you want to browse remote repositories. Local repository tracking continues normally.",
    };
  }
  if (status != null && !status.authenticated) {
    return {
      title: "GitHub CLI installed · not connected",
      detail:
        "Sign in with the existing GitHub CLI, then refresh this list. Local repository tracking continues normally.",
    };
  }
  return {
    title: "GitHub repositories unavailable",
    detail:
      "The repository list could not be refreshed. Existing tracked projects and local sources are unchanged.",
  };
}

function matches(entry: PickerEntryDto, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "owned":
      return entry.affiliation === "owner";
    case "collaborator":
      return entry.affiliation === "collaborator";
    case "org":
      return entry.affiliation === "organization_member";
    case "public":
      return entry.visibility === "public";
    case "private":
      return entry.visibility === "private";
    case "archived":
      return entry.archived;
    case "forks":
      return entry.fork;
    case "tracked":
      return entry.tracked;
    case "untracked":
      return !entry.tracked;
  }
}

/**
 * GitHub repository picker (V1.1, Sources page section).
 * Curated selection only: nothing is tracked without an explicit action,
 * and tracking never clones.
 */
export function GithubPickerSection() {
  const { data, error, loading, refetch: reload } = useApi(
    () => client.githubPicker(),
    [],
    { invalidateOn: ["picker", "projects"] },
  );
  const {
    data: statusData,
    loading: statusLoading,
    refetch: reloadStatus,
  } = useApi(() => client.githubStatus(), [], {
    invalidateOn: ["picker"],
  });
  const [filter, setFilter] = useState<FilterKey>("owned");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Per-row refresh state: fullName -> "busy" | "ok" | "failed". */
  const [rowRefresh, setRowRefresh] = useState<Record<string, "busy" | "ok" | "failed">>({});
  /** Per-row untrack state: fullName -> busy flag. */
  const [rowUntrack, setRowUntrack] = useState<Record<string, boolean>>({});
  /**
   * Pending final-binding removal on a meaningful GITHUB ONLY project:
   * the backend refused with PROJECT_HAS_NO_SOURCES and awaits an explicit
   * keep-or-delete decision from the owner.
   */
  const [pendingDelete, setPendingDelete] = useState<{
    entry: PickerEntryDto;
  } | null>(null);

  // Modal focus management: initial focus lands on the safe action
  // (cancel), Tab/Shift+Tab cycle inside the dialog, Escape closes it,
  // and focus returns to the trigger on close.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!pendingDelete) return;
    cancelButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPendingDelete(null);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [pendingDelete]);

  const entries = data?.entries ?? [];
  const githubUnavailable = error != null || (data != null && !data.available);
  const degradedMessage = unavailableMessage(statusData?.status ?? null);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((entry) => matches(entry, filter))
      .filter((entry) =>
        q
          ? `${entry.fullName} ${entry.language ?? ""}`
              .toLowerCase()
              .includes(q)
          : true,
      );
  }, [entries, filter, query]);

  const toggle = (fullName: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  };

  /**
   * Refresh ONE tracked repository's metadata + recent commits via the
   * registered-binding endpoint. Distinct from "Refresh list", which only
   * re-reads the picker discovery.
   */
  async function refreshTrackedRow(entry: PickerEntryDto): Promise<void> {
    if (!entry.tracked || entry.trackedBindingId == null) return;
    setRowRefresh((previous) => ({ ...previous, [entry.fullName]: "busy" }));
    try {
      const result = await client.refreshTrackedGithub(entry.trackedBindingId);
      setRowRefresh((previous) => ({
        ...previous,
        [entry.fullName]: result.ok ? "ok" : "failed",
      }));
      if (result.ok && (result.newCommits ?? 0) > 0) {
        setNotice(`Refreshed ${entry.fullName}: ${result.newCommits} new commit(s).`);
        // New commits feed day detail, activity, contributions, dashboard.
        notifyMutations("activity", "contributions", "dashboard", "projects");
      } else if (!result.ok) {
        setNotice(
          `Refresh failed for ${entry.fullName} (GitHub unreachable?). Tracking is unchanged.`,
        );
      }
    } catch {
      setRowRefresh((previous) => ({ ...previous, [entry.fullName]: "failed" }));
      setNotice(`Refresh failed for ${entry.fullName}. Tracking is unchanged.`);
    }
  }

  /**
   * Remove a GitHub binding from Personal Dev Hub. Never touches the real
   * GitHub repository or any local files.
   *
   * LOCAL + GITHUB rows disconnect cleanly (project survives as LOCAL ONLY).
   * For a GITHUB ONLY row whose project holds meaningful state, the backend
   * refuses with PROJECT_HAS_NO_SOURCES; we then surface an explicit
   * keep-or-delete confirmation instead of retrying destructively.
   * Returns focus to the row's trigger button after the dialog closes so
   * keyboard users are not dropped back at the document start.
   */
  async function untrackRow(entry: PickerEntryDto, confirmDeleteProject = false): Promise<void> {
    if (!entry.tracked || entry.trackedBindingId == null) return;
    setRowUntrack((previous) => ({ ...previous, [entry.fullName]: true }));
    try {
      const result = await client.untrackGithub(entry.trackedBindingId, confirmDeleteProject);
      if (result.projectDeleted) {
        setNotice(
          `Untracked ${entry.fullName}; the empty project record was removed from Personal Dev Hub.`,
        );
      } else {
        setNotice(
          `Disconnected ${entry.fullName}. The local project remains tracked as LOCAL ONLY — nothing on disk or on GitHub was touched.`,
        );
      }
      // Reconcile every derived view: binding removal changes project source
      // state, and a deleted project disappears from lists/portfolio.
      notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
      setSelected(new Set());
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === "PROJECT_HAS_NO_SOURCES" || err.status === 409)
      ) {
        // Meaningful GITHUB ONLY project: ask before deleting anything.
        setPendingDelete({ entry });
        return;
      }
      setNotice(
        err instanceof Error ? `Untrack failed: ${err.message}` : "Untrack failed.",
      );
    } finally {
      setRowUntrack((previous) => ({ ...previous, [entry.fullName]: false }));
      // Focus return: the row trigger re-renders after busy-state clears;
      // wait one frame so the ref points at the live element again.
      requestAnimationFrame(() => {
        rowActionRefs.current[entry.fullName]?.focus();
      });
    }
  }

  /** Live refs to each tracked row's primary action for focus return. */
  const rowActionRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /** Explicit owner-confirmed deletion of the remaining project record. */
  async function confirmPendingDelete(): Promise<void> {
    const pending = pendingDelete;
    if (!pending) return;
    setPendingDelete(null);
    await untrackRow(pending.entry, true);
  }

  async function trackSelected(): Promise<void> {
    if (selected.size === 0) return;
    setBusy(true);
    setNotice(null);
    let linked = 0;
    let created = 0;
    let refreshFailed = 0;
    for (const fullName of selected) {
      try {
        const result = await client.trackGithub(fullName);
        if (result.state === "LOCAL + GITHUB") linked += 1;
        else created += 1;
        // Optional bounded initial refresh; tracking already succeeded, so a
        // failure here is only surfaced as a warning.
        try {
          await client.refreshTrackedGithub(result.githubRepositoryId);
        } catch {
          refreshFailed += 1;
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === "ALREADY_TRACKED") continue;
        setNotice(
          err instanceof Error ? `Tracking failed: ${err.message}` : "Tracking failed.",
        );
        setBusy(false);
        await reload();
        return;
      }
    }
    setBusy(false);
    setSelected(new Set());
    const parts: string[] = [];
    if (linked > 0) parts.push(`${linked} linked to existing local project${linked > 1 ? "s" : ""}`);
    if (created > 0) parts.push(`${created} tracked as GitHub-only`);
    if (refreshFailed > 0) {
      parts.push(
        `initial refresh failed for ${refreshFailed} — use Refresh on the tracked row later`,
      );
    }
    setNotice(parts.length > 0 ? `Done: ${parts.join(" · ")}.` : "Nothing new to track.");
    if (linked + created > 0) {
      // New bindings change project source state and may create projects.
      notifyMutations("projects", "sources", "dashboard", "activity", "contributions", "portfolio", "picker");
    } else {
      await reload();
    }
  }

  return (
    <section className="panel">
      <div className="picker-head">
        <div>
          <h2>
            <span className="h2-mark" aria-hidden="true" />
            GitHub Repositories
          </h2>
          <p className="source-section-note">
            Select existing GitHub repositories to track. Personal Dev Hub never
            clones them.
          </p>
        </div>
        <button
          className="btn subtle refresh-action"
          onClick={() => void Promise.all([reload(), reloadStatus()])}
          disabled={loading || statusLoading}
        >
          Refresh list
        </button>
      </div>

      {loading || (githubUnavailable && statusLoading) ? (
        <p className="empty-line">Loading repositories…</p>
      ) : githubUnavailable ? (
        <div className="github-degraded">
          <strong>{degradedMessage.title}</strong>
          <span>{degradedMessage.detail}</span>
        </div>
      ) : (
        <>
          <div className="picker-controls">
            <label className="form-field">
              <span>Search repositories</span>
              <input
                className="input picker-search"
                placeholder="Search name or language…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="chip-row">
              {FILTERS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={filter === option.key}
                  className={`chip ${filter === option.key ? "active" : ""}`}
                  onClick={() => setFilter(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="empty-line">No repositories match.</p>
          ) : (
            <ul className="picker-list">
              {visible.map((entry) => {
                const isSelected = selected.has(entry.fullName);
                return (
                  <li
                    key={entry.fullName}
                    className={`picker-row ${isSelected ? "selected" : ""}`}
                  >
                    <label className="picker-main">
                      <input
                        type="checkbox"
                        checked={isSelected || entry.tracked}
                        disabled={entry.tracked || busy}
                        onChange={() => toggle(entry.fullName)}
                      />
                      <span className="picker-name mono">{entry.fullName}</span>
                      <span className="picker-meta">
                        {[entry.language, entry.visibility]
                          .filter(Boolean)
                          .map((piece) => piece)
                          .join(" · ")}
                        {entry.archived ? " · archived" : ""}
                        {entry.fork ? " · fork" : ""}
                      </span>
                    </label>
                    <span className={`picker-state ${entry.tracked ? "on" : ""}`}>
                      {entry.tracked
                        ? entry.localCopyPath
                          ? "Tracked · local copy"
                          : "Tracked"
                        : entry.localCopyPath
                          ? "Local copy detected"
                          : "GitHub only"}
                    </span>
                    {entry.tracked ? (
                      <span className="picker-actions">
                        <button
                          type="button"
                          ref={(element) => {
                            rowActionRefs.current[entry.fullName] = element;
                          }}
                          className="btn subtle refresh-action"
                          disabled={rowRefresh[entry.fullName] === "busy" || rowUntrack[entry.fullName]}
                          title="Refresh this tracked repository's metadata and recent commits"
                          onClick={() => void refreshTrackedRow(entry)}
                        >
                          {rowRefresh[entry.fullName] === "busy"
                            ? "Refreshing…"
                            : rowRefresh[entry.fullName] === "failed"
                              ? "Retry refresh"
                              : "Refresh"}
                        </button>
                        {entry.localCopyPath ? (
                          <button
                            type="button"
                            className="btn subtle danger"
                            disabled={rowUntrack[entry.fullName]}
                            title="Remove the GitHub binding from Personal Dev Hub. The local project stays LOCAL ONLY; nothing on disk or on GitHub is touched."
                            onClick={() => void untrackRow(entry)}
                          >
                            {rowUntrack[entry.fullName] ? "Disconnecting…" : "Disconnect GitHub"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn subtle danger"
                            disabled={rowUntrack[entry.fullName]}
                            title="Stop tracking this repository in Personal Dev Hub. The real GitHub repository is never modified."
                            onClick={() => void untrackRow(entry)}
                          >
                            {rowUntrack[entry.fullName] ? "Untracking…" : "Untrack"}
                          </button>
                        )}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="picker-foot">
            <span className="hint-text">
              Tracking never clones anything — local copies stay where they are.
            </span>
            <button
              className="btn primary"
              onClick={() => void trackSelected()}
              disabled={selected.size === 0 || busy}
            >
              {busy
                ? "Tracking…"
                : `Track selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </button>
          </div>
          {notice != null ? (
            <p className="empty-line" role="status">
              {notice}
            </p>
          ) : null}
        </>
      )}
      {pendingDelete != null ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal"
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="untrack-confirm-title"
            aria-describedby="untrack-confirm-body"
          >
            <h3 id="untrack-confirm-title">Keep this project?</h3>
            <p id="untrack-confirm-body">
              Disconnecting <strong>{pendingDelete.entry.fullName}</strong> would
              leave its Personal Dev Hub project with no tracked source. The
              project still has history or metadata stored here.
            </p>
            <p className="mono muted" style={{ fontSize: 12 }}>
              The real GitHub repository is never modified by this action.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                ref={cancelButtonRef}
                className="btn subtle"
                onClick={() => setPendingDelete(null)}
              >
                Keep project (cancel)
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => void confirmPendingDelete()}
              >
                Delete project from Personal Dev Hub
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
