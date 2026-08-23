import type { GitHubTerm } from "./status-terms.js";

export type DiscoveryType = "scanned" | "manual";

export type EventType =
  | "repository_discovered"
  | "commit"
  | "working_tree_dirty"
  | "working_tree_clean"
  | "branch_changed"
  | "ahead_changed"
  | "behind_changed";

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

export type DashboardResponse = {
  trackedProjects: number;
  uncommittedProjects: number;
  activeThisWeek: number;
  commitsThisWeek: number;
  needsAttention: RepositoryListItem[];
  recentProjects: RepositoryListItem[];
  recentActivity: ActivityEventDto[];
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
