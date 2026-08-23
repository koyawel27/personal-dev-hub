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

export function eventLabel(eventType: string): string {
  switch (eventType) {
    case "repository_discovered":
      return "Discovered";
    case "commit_observed":
      return "Commit";
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
      return eventType;
  }
}
