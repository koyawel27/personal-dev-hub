import type { GitHubTerm } from "./status-terms.js";

export type DiscoveryType = "scanned" | "manual";

export const PROJECT_STATUSES = [
  "Active",
  "Paused",
  "Finished",
  "Archived",
  "Experiment",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TYPES = [
  "Personal",
  "School",
  "OJT",
  "Client",
  "Experiment",
  "Other",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** Partial update payload for manual project metadata. */
export type UpdateMetadataRequest = {
  projectStatus?: ProjectStatus | null;
  projectType?: ProjectType | null;
  projectNote?: string | null;
  includeInPortfolio?: boolean;
  portfolioOrder?: number | null;
};

/** One day of contribution activity. Counts are commit counts, never hours. */
export type ContributionDayDto = {
  date: string;
  /** Distinct commit SHAs across all sources (deduplicated combined total). */
  total: number;
  /** Portion contributed by local Git observation. */
  localCount: number;
  /** Portion contributed by GitHub enrichment only (not already local). */
  githubCount: number;
};

export type DailyProjectCommits = {
  repositoryId: number;
  projectName: string;
  commits: CommitDto[];
};

export type DailyDetailResponse = {
  date: string;
  /** Distinct commit SHAs for the day across all projects. */
  totalCommits: number;
  projects: DailyProjectCommits[];
};

/** Selected-work item generated from tracked data (spec section 10). */
export type PortfolioItemDto = {
  id: number;
  name: string;
  projectType: ProjectType | null;
  projectStatus: ProjectStatus | null;
  projectNote: string | null;
  githubHtmlUrl: string | null;
  portfolioOrder: number | null;
  /** Honest manifest-derived hints; empty when nothing recognizable. */
  technologyHints: string[];
  firstCommitAt: string | null;
  latestCommitAt: string | null;
  lastMeaningfulAt: string | null;
};

export type EventType =
  | "repository_discovered"
  | "commit_observed"
  | "project_status_changed"
  | "project_note_updated"
  | "working_tree_dirty"
  | "working_tree_clean"
  | "branch_changed"
  | "ahead_changed"
  | "behind_changed";

/** Compact per-project summary used by Dashboard "Recently Active". */
export type RecentlyActiveProjectDto = {
  id: number;
  name: string;
  projectStatus: ProjectStatus | null;
  projectType: ProjectType | null;
  branch: string | null;
  workingTree: "Clean" | "Uncommitted";
  sync: string;
  githubConnected: boolean;
  localPath: string;
  /** Time of the most recent meaningful activity event, if any. */
  lastMeaningfulAt: string | null;
  latestCommitSubject: string | null;
};

export type AttentionReason =
  | "uncommitted changes"
  | "ahead of upstream"
  | "behind upstream"
  | "ahead and behind upstream"
  | "no upstream branch"
  | "repository path unavailable"
  | "GitHub enrichment unavailable";

export type DashboardResponse = {
  trackedProjects: number;
  activeProjects: number;
  commitsThisWeek: number;
  activeDaysThisWeek: number;
  uncommittedRepositories: number;
  recentlyActive: RecentlyActiveProjectDto[];
  needsAttention: Array<RecentlyActiveProjectDto & { attentionReasons: AttentionReason[] }>;
  recentActivity: ActivityEventDto[];
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export type HealthResponse = {
  ok: true;
  git: "available" | "unavailable";
};

export type SourceDto = {
  id: number;
  path: string;
  canonicalPath: string;
  scanDepth: number;
  enabled: boolean;
  createdAt: string;
  lastScannedAt: string | null;
  repositoryCount: number;
};

export type ChangedFile = {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
  kind: "staged" | "modified" | "untracked" | "renamed" | "deleted";
};

export type RemoteDto = {
  name: string;
  url: string;
  host: string | null;
  owner: string | null;
  repositoryName: string | null;
  isPrimary: boolean;
  isGitHub: boolean;
  htmlUrl: string | null;
};

export type CommitDto = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string | null;
  committedAt: string | null;
};

export type GitHubMetadataDto = {
  owner: string;
  name: string;
  fullName: string;
  visibility: string | null;
  defaultBranch: string | null;
  htmlUrl: string;
  lastPushedAt: string | null;
};

export type SnapshotDto = {
  branch: string | null;
  headCommitSha: string | null;
  isDirty: boolean;
  modifiedCount: number;
  stagedCount: number;
  untrackedCount: number;
  upstreamRef: string | null;
  aheadCount: number | null;
  behindCount: number | null;
  capturedAt: string;
};

export type RepositoryListItem = {
  id: number;
  name: string;
  localPath: string;
  canonicalPath: string;
  discoveryType: DiscoveryType;
  sourceId: number | null;
  lastScannedAt: string | null;
  snapshot: SnapshotDto | null;
  projectStatus: ProjectStatus | null;
  projectType: ProjectType | null;
  projectNote: string | null;
  includeInPortfolio: boolean;
  portfolioOrder: number | null;
  workingTree: "Clean" | "Uncommitted";
  sync: string;
  github: GitHubTerm;
  githubHtmlUrl: string | null;
  lastActivityAt: string | null;
  lastActivitySummary: string | null;
};

export type RepositoryDetail = RepositoryListItem & {
  changedFiles: ChangedFile[];
  remotes: RemoteDto[];
  commits: CommitDto[];
  githubMetadata: GitHubMetadataDto | null;
};

export type ActivityEventDto = {
  id: number;
  localRepositoryId: number;
  projectName: string;
  eventType: EventType;
  summary: string;
  occurredAt: string;
  source: string;
};

export type GitHubStatusDto = {
  installed: boolean;
  authenticated: boolean;
  accountName: string | null;
};

export type ScanSummary = {
  sourcesScanned: number;
  repositoriesDiscovered: number;
  repositoriesRefreshed: number;
};
