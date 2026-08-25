export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
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
