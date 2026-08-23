export type WorkingTreeTerm = "Clean" | "Uncommitted";

export type SyncTerm =
  | "Synced"
  | `Ahead ${number}`
  | `Behind ${number}`
  | `Ahead ${number} · Behind ${number}`
  | "No upstream";

export type GitHubTerm = "GitHub Connected" | "Local Only" | "GitHub Unavailable";

export const EMPTY_STATES = {
  noProjects: "No projects tracked yet.",
  noActivity: "No activity recorded yet.",
  noAttention: "No projects need attention.",
  noSearchMatch: "No projects match your search.",
  githubUnavailable:
    "GitHub enrichment is unavailable. Local repository tracking continues normally.",
} as const;

export const LOCAL_REMOTE_DISCLAIMER = "Based on locally known remote state.";

export function workingTreeTerm(isDirty: boolean): WorkingTreeTerm {
  return isDirty ? "Uncommitted" : "Clean";
}

export function syncTerm(
  upstreamRef: string | null | undefined,
  aheadCount: number | null | undefined,
  behindCount: number | null | undefined,
): SyncTerm {
  if (!upstreamRef) return "No upstream";
  const ahead = aheadCount ?? 0;
  const behind = behindCount ?? 0;
  if (ahead > 0 && behind > 0) return `Ahead ${ahead} · Behind ${behind}`;
  if (ahead > 0) return `Ahead ${ahead}`;
  if (behind > 0) return `Behind ${behind}`;
  return "Synced";
}

export function githubTerm(hasGitHubRemote: boolean): GitHubTerm {
  return hasGitHubRemote ? "GitHub Connected" : "Local Only";
}

export const QUALIFYING_ACTIVITY_TYPES = [
  "commit_observed",
  "working_tree_dirty",
  "working_tree_clean",
  "branch_changed",
  "ahead_changed",
  "behind_changed",
] as const;

export type QualifyingActivityType = (typeof QUALIFYING_ACTIVITY_TYPES)[number];
