import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  LocalBindingHealthState,
  SourceHealthItemDto,
  SourceHealthResponse,
} from "@shared/api-types";
import { ApiError, client } from "../api";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import {
  localBindingHealthLabel,
  localBindingHealthTitle,
  relativeTime,
} from "../format";
import { relinkLocalBinding } from "../lib/relinkLocalBinding";
import { notifyMutations } from "../lib/mutations";

/**
 * V1.3 M4 Source Health Center (Maintenance).
 *
 * Attention surface for local bindings that need owner action. Reads are
 * Git-process-free; only explicit Rescan / Relink may run Git or rewrite
 * a tracked path (via existing V1.2 repair workflows).
 */

const STATE_TONE: Record<LocalBindingHealthState, "warn" | "neutral"> = {
  PATH_MISSING: "warn",
  NOT_A_GIT_REPO: "warn",
  UNSCANNED: "neutral",
  OK: "neutral",
};

function stateLabel(state: LocalBindingHealthState): string {
  switch (state) {
    case "PATH_MISSING":
      return "Missing path";
    case "NOT_A_GIT_REPO":
      return "Not a Git repository";
    case "UNSCANNED":
      return "Not yet scanned";
    default:
      return state;
  }
}

export function SourceHealthPanel() {
  const [data, setData] = useState<SourceHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const result = await client.sourceHealth();
    setData(result);
    setError(null);
  }, []);

  useEffect(() => {
    reload().catch((err: unknown) => {
      setData({
        totalLocalBindings: 0,
        attentionCount: 0,
        pathMissingCount: 0,
        notGitRepoCount: 0,
        unscannedCount: 0,
        items: [],
      });
      setError(
        err instanceof ApiError ? err.message : "Failed to load source health.",
      );
    });
  }, [reload]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Cross-view reconciliation after a SUCCESSFUL local-binding repair.
   * Must match Project Detail / Sources Rescan & Relink so every affected
   * view refetches. Never called on cancel, declined confirm, or failure.
   */
  function notifyRepairSucceeded(): void {
    notifyMutations(
      "projects",
      "sources",
      "dashboard",
      "activity",
      "contributions",
      "portfolio",
      "picker",
    );
  }

  async function rescan(bindingId: number) {
    await run(async () => {
      await client.refresh(bindingId);
      notifyRepairSucceeded();
      await reload();
      setNotice("Local copy rescanned.");
    });
  }

  async function relink(bindingId: number) {
    // Cancelled picker / declined confirmation is not an error.
    let selection: { path: string | null } | null = null;
    try {
      selection = await client.selectFolder();
    } catch {
      return;
    }
    const selectedPath = selection?.path;
    if (!selectedPath) return;

    await run(async () => {
      const result = await relinkLocalBinding(bindingId, selectedPath);
      if (result == null) {
        // Owner declined the evidence confirmation; nothing changed.
        return;
      }
      notifyRepairSucceeded();
      await reload();
      setNotice("Local copy relinked.");
    });
  }

  return (
    <section className="panel source-health-panel">
      <div className="panel-head-row">
        <h2>
          <span className="h2-mark" aria-hidden="true" />
          Source Health
        </h2>
      </div>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="notice" role="status">
          {notice}
        </div>
      ) : null}

      {data == null ? (
        <p className="empty">Loading source health…</p>
      ) : (
        <>
          <p className="source-health-summary">
            {data.attentionCount === 0 ? (
              <>All tracked local copies are currently healthy.</>
            ) : (
              <>
                <strong>
                  {data.attentionCount} local{" "}
                  {data.attentionCount === 1 ? "copy needs" : "copies need"}{" "}
                  attention
                </strong>
              </>
            )}
          </p>
          <div className="source-health-counts binding-meta">
            <span>Missing paths: {data.pathMissingCount}</span>
            <span>Not Git repositories: {data.notGitRepoCount}</span>
            <span>Not yet scanned: {data.unscannedCount}</span>
            <span className="muted">
              {data.totalLocalBindings} local {data.totalLocalBindings === 1 ? "copy" : "copies"} total
            </span>
          </div>

          {data.items.length === 0 ? (
            <EmptyState
              message="All tracked local copies are currently healthy."
              hint="Health reflects the last explicit scan/refresh, not a live Git check."
            />
          ) : (
            <ul className="source-health-list" aria-label="Local copies needing attention">
              {data.items.map((item) => (
                <li
                  key={item.bindingId}
                  className="source-health-row"
                  data-testid={`source-health-${item.bindingId}`}
                >
                  <div className="binding-main">
                    <div className="backup-title-line">
                      <Link
                        to={`/projects/${item.projectId}`}
                        className="source-health-project"
                      >
                        {item.projectName}
                      </Link>
                      {item.isPrimary ? (
                        <span className="primary-tag mono">Primary</span>
                      ) : null}
                      <Badge tone={STATE_TONE[item.health.state] ?? "neutral"}>
                        {stateLabel(item.health.state)}
                      </Badge>
                    </div>
                    <div className="binding-meta">
                      <span className="mono binding-path" title={item.localPath}>
                        {item.localPath}
                      </span>
                      <span
                        title={localBindingHealthTitle(item.health)}
                      >
                        {localBindingHealthLabel(item.health)}
                      </span>
                      {item.health.checkedAt ? (
                        <span className="muted" title={item.health.checkedAt}>
                          Last scanned {relativeTime(item.health.checkedAt)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="backup-actions">
                    {item.health.state === "PATH_MISSING" ? (
                      <button
                        type="button"
                        disabled={busy}
                        title="Point this local copy at a moved or renamed folder"
                        onClick={() => void relink(item.bindingId)}
                      >
                        Relink
                      </button>
                    ) : null}
                    {item.health.state === "NOT_A_GIT_REPO" ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          title="Rescan this folder if it has since become a Git repository"
                          onClick={() => void rescan(item.bindingId)}
                        >
                          Rescan
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          title="Point this local copy at a moved or renamed folder"
                          onClick={() => void relink(item.bindingId)}
                        >
                          Relink
                        </button>
                      </>
                    ) : null}
                    {item.health.state === "UNSCANNED" ? (
                      <button
                        type="button"
                        disabled={busy}
                        title="Run the first explicit scan of this local copy"
                        onClick={() => void rescan(item.bindingId)}
                      >
                        Rescan
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="settings-tool-note">
            Health uses stored scan results plus a folder existence check. Git
            runs only when you choose Rescan or Relink. Tracked repositories are
            never modified by this panel.
          </p>
        </>
      )}
    </section>
  );
}
