import type { LocalBindingHealthDto } from "@shared/api-types";
import { LOCAL_BINDING_HEALTH_TERMS } from "@shared/status-terms";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** Compact file size for backup rows and technical metadata. */
export function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = sizeBytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}

/**
 * V1.2 M2: user-facing wording for one local binding's health (M2-J).
 * Relative time inline, absolute timestamp reserved for the title (D9).
 * "Last scanned …" is a cached-verdict statement, never live verification.
 */
export function localBindingHealthLabel(health: LocalBindingHealthDto): string {
  switch (health.state) {
    case "OK":
      return health.checkedAt
        ? `Last scanned ${relativeTime(health.checkedAt)}`
        : LOCAL_BINDING_HEALTH_TERMS.OK;
    case "NOT_A_GIT_REPO":
      return health.checkedAt
        ? `${LOCAL_BINDING_HEALTH_TERMS.NOT_A_GIT_REPO} (checked ${relativeTime(health.checkedAt)})`
        : LOCAL_BINDING_HEALTH_TERMS.NOT_A_GIT_REPO;
    case "PATH_MISSING":
      return LOCAL_BINDING_HEALTH_TERMS.PATH_MISSING;
    default:
      return LOCAL_BINDING_HEALTH_TERMS.UNSCANNED;
  }
}

/** Hover text for the health label: absolute timestamps where one exists. */
export function localBindingHealthTitle(health: LocalBindingHealthDto): string {
  switch (health.state) {
    case "OK":
      return health.checkedAt
        ? `Last scanned ${formatDateTime(health.checkedAt)}`
        : LOCAL_BINDING_HEALTH_TERMS.OK;
    case "NOT_A_GIT_REPO":
      return health.checkedAt
        ? `Last check ${formatDateTime(health.checkedAt)}: not a Git repository`
        : LOCAL_BINDING_HEALTH_TERMS.NOT_A_GIT_REPO;
    case "PATH_MISSING":
      return "The tracked folder was not found on disk when this page was rendered. No Git check was run; refresh once the folder is back.";
    default:
      return "This local copy has not been scanned yet. Rescan to record its first snapshot.";
  }
}

/** Compact relative time for dense lists; full timestamps stay in tooltips. */
export function relativeTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function eventLabel(eventType: string): string {
  switch (eventType) {
    case "repository_discovered":
      return "Discovered";
    case "commit_observed":
    case "github_commit_observed":
      // Merged LOCAL + GITHUB rows keep the same readable label; the
      // composition is shown by a source badge, not the event name.
      return "Commit";
    case "github_repo_tracked":
      return "GitHub connected";
    case "github_repo_untracked":
      return "GitHub disconnected";
    case "github_binding_updated":
      return "GitHub updated";
    case "project_status_changed":
      return "Status";
    case "project_note_updated":
      return "Note";
    case "working_tree_dirty":
      return "Uncommitted";
    case "working_tree_clean":
      return "Clean";
    case "branch_changed":
      return "Branch";
    case "ahead_changed":
      return "Ahead";
    case "behind_changed":
      return "Behind";
    default:
      // Safe fallback for future event types: never show raw snake_case.
      return eventType
        .replace(/[_-]+/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());
  }
}
