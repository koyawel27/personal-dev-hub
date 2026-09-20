import type { ProjectLocalBindingDto } from "@shared/api-types";
import { LOCAL_REMOTE_DISCLAIMER, syncTerm } from "@shared/status-terms";
import {
  localBindingHealthLabel,
  localBindingHealthTitle,
  shortSha,
} from "../format";
import { WorkingTreeBadge } from "./Badge";
import { EmptyState } from "./EmptyState";

type LaunchAction = "folder" | "terminal" | "vscode";

type LocalBindingsPanelProps = {
  /** Server-authoritative bindings (display primary first) from Project Detail. */
  bindings: ProjectLocalBindingDto[];
  busy: boolean;
  onAdd: () => void;
  onOpen: (bindingId: number, action: LaunchAction) => void;
  onRescan: (bindingId: number) => void;
  onRelink: (bindingId: number) => void;
  onMakePrimary: (bindingId: number) => void;
  onRemove: (bindingId: number) => void;
};

/**
 * V1.2 M3: first-class Local Copies panel on Project Detail.
 *
 * Renders EVERY entry of project.localBindings — the M2 server-authoritative
 * read model — for LOCAL ONLY, LOCAL + GITHUB, and GITHUB ONLY projects.
 * The list is never reconstructed from GET /api/repositories here. One
 * restrained dense row per binding: path, Primary tag, per-binding health
 * (M2 formatter wording), branch, working-tree state, and sync, followed by
 * the existing safe per-binding actions. The sync figures describe the
 * locally known remote state only (same disclaimer as the dashboard).
 */
export function LocalBindingsPanel({
  bindings,
  busy,
  onAdd,
  onOpen,
  onRescan,
  onRelink,
  onMakePrimary,
  onRemove,
}: LocalBindingsPanelProps) {
  return (
    <>
      <div className="panel-head-row">
        <span className="section-count mono">{bindings.length}</span>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={onAdd}
        >
          Add local copy
        </button>
      </div>
      {bindings.length === 0 ? (
        <EmptyState
          message="No local copies attached. This project is tracked from GitHub only."
          hint="Add local copy attaches an existing folder on this machine — nothing is cloned or modified."
        />
      ) : (
        <ul className="bindings-list">
          {bindings.map((binding) => {
            const snapshot = binding.snapshot;
            return (
              <li
                key={binding.id}
                className="binding-row"
                data-testid={`local-binding-${binding.id}`}
              >
                <div className="binding-main">
                  <div className="binding-path-line">
                    <span className="mono binding-path" title={binding.localPath}>
                      {binding.localPath}
                    </span>
                    {binding.isPrimary ? (
                      <span className="primary-tag mono" title="This copy is the project's display primary. Header actions operate on it.">
                        Primary
                      </span>
                    ) : null}
                  </div>
                  <div className="binding-meta">
                    <span className="mono">{snapshot?.branch ?? "—"}</span>
                    {snapshot ? (
                      <>
                        <WorkingTreeBadge isDirty={snapshot.isDirty} />
                        <span className="mono muted">
                          {shortSha(snapshot.headCommitSha)}
                        </span>
                        <span className="mono muted">
                          {syncTerm(
                            snapshot.upstreamRef,
                            snapshot.aheadCount,
                            snapshot.behindCount,
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="muted">Not scanned</span>
                    )}
                    <span
                      title={localBindingHealthTitle(binding.health)}
                    >
                      {localBindingHealthLabel(binding.health)}
                    </span>
                  </div>
                </div>
                <div className="binding-actions row-actions">
                  <button
                    type="button"
                    className="subtle"
                    disabled={busy}
                    title="Open this copy's folder in File Explorer"
                    onClick={() => onOpen(binding.id, "folder")}
                  >
                    Open Folder
                  </button>
                  <button
                    type="button"
                    className="subtle"
                    disabled={busy}
                    title="Open a terminal in this copy's folder"
                    onClick={() => onOpen(binding.id, "terminal")}
                  >
                    Open Terminal
                  </button>
                  <button
                    type="button"
                    className="subtle"
                    disabled={busy}
                    title="Open this copy's folder in VS Code"
                    onClick={() => onOpen(binding.id, "vscode")}
                  >
                    Open VS Code
                  </button>
                  <button
                    type="button"
                    className="subtle"
                    disabled={busy}
                    title="Re-inspect this copy's Git state now (read-only)"
                    onClick={() => onRescan(binding.id)}
                  >
                    Rescan
                  </button>
                  <button
                    type="button"
                    className="subtle"
                    disabled={busy}
                    title="Choose the current folder for this existing binding. History is preserved; files on disk are never moved."
                    onClick={() => onRelink(binding.id)}
                  >
                    Relink…
                  </button>
                  {!binding.isPrimary ? (
                    <button
                      type="button"
                      className="subtle"
                      disabled={busy}
                      title="Show this copy as the project's primary local copy. No Git operation, no filesystem change."
                      onClick={() => onMakePrimary(binding.id)}
                    >
                      Make primary
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="subtle danger"
                    disabled={busy}
                    title="Remove this copy from the dashboard. Files on disk are never deleted."
                    onClick={() => onRemove(binding.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {bindings.length > 0 ? (
        <p className="hint-text">{LOCAL_REMOTE_DISCLAIMER}</p>
      ) : null}
    </>
  );
}
