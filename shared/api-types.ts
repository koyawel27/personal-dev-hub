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
  /** Distinct commits fetched from tracked GitHub bindings (independent count). */
  githubCount: number;
};

/** Contribution aggregation view (V1.1): honest per-source lenses. */
export type ContributionView = "local" | "github" | "combined";

/** Compact real statistics for a contributions view (no trends/streaks). */
export type ContributionTotals = {
  /** Unique commits under the selected lens. */
  commits: number;
  /** Days with at least one commit under the selected lens. */
  activeDays: number;
  /** Projects that contributed under the selected lens. */
  projects: number;
};

/**
 * Combined-view transparency: proves the combined number is a union, not a
 * naive sum. overlap = SHAs observed in BOTH stores; combinedUnique =
 * localObserved ∪ githubObserved.
 */
export type ContributionDedup = {
  localObserved: number;
  githubObserved: number;
  overlap: number;
  combinedUnique: number;
};

/** Years that hold tracked commit data (for the year selector). */
export type ContributionYearsDto = {
  years: number[];
};

export type DailyProjectCommits = {
  repositoryId: number;
  projectName: string;
  /** "local" | "github" | "LOCAL + GITHUB" (dual observation). */
  source: string;
  commits: CommitDto[];
};

export type DailyDetailResponse = {
  date: string;
  /** Distinct commit SHAs for the day across all projects. */
  totalCommits: number;
  /** Which lens produced this response. */
  view: ContributionView;
  /** Present when view=combined and some GitHub data was unavailable. */
  partial?: boolean;
  projects: DailyProjectCommits[];
};

/** Selected-work item generated from tracked data (spec section 10). */
export type PortfolioItemDto = {
  id: number;
  name: string;
  sourceState: SourceState;
  projectType: ProjectType | null;
  projectStatus: ProjectStatus | null;
  projectNote: string | null;
  githubHtmlUrl: string | null;
  portfolioOrder: number | null;
  /**
   * Honest hints only: local manifest probes, plus GitHub's reported
   * primary language for GitHub-only items (explicitly GitHub metadata,
   * not a stack analysis — owner decision Q4).
   */
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
  | "behind_changed"
  | "github_repo_tracked"
  | "github_repo_untracked"
  | "github_commit_observed"
  | "github_binding_updated";

/** First-class source composition of a Project (derived, never stored).
 *  "NO SOURCE" is transient-only (mid-transaction or pre-repair ghosts);
 *  it must never be persisted as a resting user-facing state. */
export type SourceState = "LOCAL + GITHUB" | "LOCAL ONLY" | "GITHUB ONLY" | "NO SOURCE";

/** Response for removing a local repository binding (dashboard row). */
export type DeleteLocalBindingResponse = {
  ok: true;
  /** True when the owning Project record was removed (final binding, empty). */
  projectDeleted: boolean;
};

/** Native folder-picker result. Cancellation is a normal, non-error outcome. */
export type FolderSelectionResponse = {
  selected: boolean;
  /** Absolute folder path when selected; null on cancellation or absence. */
  path: string | null;
};

/** Compact per-project summary used by Dashboard "Recently Active". */
export type RecentlyActiveProjectDto = {
  id: number;
  name: string;
  sourceState: SourceState;
  projectStatus: ProjectStatus | null;
  projectType: ProjectType | null;
  branch: string | null;
  workingTree: "Clean" | "Uncommitted" | "Unavailable";
  sync: string;
  githubConnected: boolean;
  /** Primary local copy path; null for GITHUB ONLY projects. */
  localPath: string | null;
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
  /** Day-detail only: "local" | "github" | "LOCAL + GITHUB". */
  source?: string;
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

/**
 * V1.2 M1: response for POST /api/repositories/:id/primary. The switch is a
 * pure display-preference flip; the payload carries only enough state for
 * UI/cache reconciliation. The fingerprint anchor is an INTERNAL persistence
 * identity (owner decision D1) and is deliberately NOT exposed to clients.
 */
export type SetPrimaryLocalBindingResponse = {
  ok: true;
  projectId: number;
  primaryRepositoryId: number;
};

/**
 * V1.2 M3: request for POST /api/projects/:projectId/local-bindings
 * (owner-directed Add Local Copy). The Project already exists; the folder is
 * attached to it directly — no Project is created, moved, or replaced.
 */
export type AddLocalBindingRequest = {
  path: string;
  /**
   * Owner confirmation for the unverified-evidence flow (M3-E): the first
   * attempt without it may be answered with LOCAL_BINDING_CONFIRM_REQUIRED;
   * retrying with true attaches after the owner accepted the evidence
   * summary. It can NEVER bypass a strong identity conflict.
   */
  confirmUnverified?: boolean;
};

/**
 * V1.2 M3: success response for Add Local Copy. The new binding plus the
 * full server-authoritative Project Detail read model, so the client can
 * reconcile every binding surface from one payload without refetching.
 */
export type AddLocalBindingResponse = {
  binding: ProjectLocalBindingDto;
  project: ProjectDetailDto;
};

export type RepositoryListItem = {
  id: number;
  /** Owning project id (V1.1: metadata lives on the Project). */
  projectId: number | null;
  /**
   * V1.2 M1: server-authoritative display primary. Exactly one local
   * binding per project carries this; clients must consume it instead of
   * re-deriving a primary by name or row order.
   */
  isPrimary: boolean;
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
  /** Owning project id (0 only for legacy unlinked rows). */
  projectId: number;
  localRepositoryId: number;
  projectName: string;
  eventType: EventType;
  summary: string;
  occurredAt: string;
  /**
   * Observation composition for commit rows: LOCAL, GITHUB, or
   * LOCAL + GITHUB (same Project + SHA observed by both). Non-commit rows
   * keep their raw storage origin ("scan" | "user").
   */
  source: string;
  /** Commit identity when this row is (or merges) a commit observation. */
  sha?: string;
};

/** Picker row served by GET /api/github/repositories. */
export type PickerEntryDto = {
  owner: string;
  name: string;
  fullName: string;
  visibility: string | null;
  language: string | null;
  description: string | null;
  archived: boolean;
  fork: boolean;
  affiliation: "owner" | "collaborator" | "organization_member";
  pushedAt: string | null;
  tracked: boolean;
  /** github_repositories.id when tracked; safe handle for refresh/untrack. */
  trackedBindingId: number | null;
  localCopyPath: string | null;
};

/** Project list row served by GET /api/projects. */
export type ProjectListItemDto = {
  id: number;
  name: string;
  sourceState: SourceState;
  projectStatus: ProjectStatus | null;
  projectType: ProjectType | null;
  includeInPortfolio: boolean;
  portfolioOrder: number | null;
  /** Primary local copy path; null for GITHUB ONLY projects. */
  localPath: string | null;
  githubFullName: string | null;
  githubHtmlUrl: string | null;
  lastMeaningfulAt: string | null;
};

/**
 * V1.2 M2: health of one local binding.
 *
 * OK means "OK as of the last explicit scan/refresh" — it is a cached Git
 * verdict, never a claim of live verification during page rendering.
 * PATH_MISSING and UNSCANNED are derived at read time (live filesystem
 * existence check / absent cache) and are never persisted.
 */
export type LocalBindingHealthState =
  | "UNSCANNED"
  | "OK"
  | "PATH_MISSING"
  | "NOT_A_GIT_REPO";

export type LocalBindingHealthDto = {
  state: LocalBindingHealthState;
  /** When the cached state was last explicitly verified; null for derived states. */
  checkedAt: string | null;
};

/**
 * V1.2 M2: one local binding of a Project as read data. Each binding owns
 * its own path, latest snapshot, and health — Project-level legacy fields
 * keep deriving ONLY from the server-authoritative display primary.
 */
export type ProjectLocalBindingDto = {
  id: number;
  isPrimary: boolean;
  name: string;
  localPath: string;
  canonicalPath: string;
  discoveryType: DiscoveryType;
  sourceId: number | null;
  lastScannedAt: string | null;
  snapshot: SnapshotDto | null;
  health: LocalBindingHealthDto;
};

/** Source-aware project detail served by GET /api/projects/:id. */
export type ProjectDetailDto = ProjectListItemDto & {
  projectNote: string | null;
  snapshot: SnapshotDto | null;
  /** Every local binding of the Project: display primary first, then id ASC. */
  localBindings: ProjectLocalBindingDto[];
  githubMetadata: GitHubMetadataDto | null;
  commits: Array<{
    sha: string;
    shortSha: string;
    subject: string;
    authorName: string | null;
    committedAt: string | null;
    source: "local" | "github";
  }>;
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
