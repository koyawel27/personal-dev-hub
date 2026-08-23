import type {
  ActivityEventDto,
  CommitDto,
  DashboardResponse,
  GitHubMetadataDto,
  RemoteDto,
  RepositoryDetail,
  RepositoryListItem,
  ScanSummary,
  SnapshotDto,
} from "../../../shared/api-types.js";
import { parseGitHubRemote } from "../../../shared/github-remote.js";
import {
  pathIdentity,
  repositoryNameFromPath,
} from "../../../shared/paths.js";
import {
  githubTerm,
  QUALIFYING_ACTIVITY_TYPES,
  syncTerm,
  workingTreeTerm,
} from "../../../shared/status-terms.js";
import { getDb, nowIso, withTransaction } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { resolveExistingDirectory } from "../lib/fsPaths.js";
import {
  deriveActivityEvents,
  persistActivityEvents,
  type PreviousSnapshot,
} from "./ActivityService.js";
import { fetchGitHubRepoMetadata } from "./GitHubService.js";
import { inspectRepository, isRepository, type GitInspection } from "./GitService.js";
import {
  findGitRepositories,
  getSource,
  listEnabledSources,
  markSourceScanned,
} from "./ProjectDiscoveryService.js";

type RepoRow = {
  id: number;
  source_id: number | null;
  name: string;
  local_path: string;
  canonical_path: string;
  discovery_type: "scanned" | "manual";
  created_at: string;
  last_scanned_at: string | null;
};

type SnapshotRow = {
  branch: string | null;
  head_commit_sha: string | null;
  is_dirty: number;
  modified_count: number;
  staged_count: number;
  untracked_count: number;
  upstream_ref: string | null;
  ahead_count: number | null;
  behind_count: number | null;
  captured_at: string;
};

type RemoteRow = {
  name: string;
  url: string;
  host: string | null;
  owner: string | null;
  repository_name: string | null;
  is_primary: number;
  html_url: string | null;
};

type ActivityRow = {
  id: number;
  local_repository_id: number;
  project_name: string;
  event_type: ActivityEventDto["eventType"];
  summary: string;
  occurred_at: string;
  source: string;
};

let scanLock: Promise<unknown> | null = null;

async function withScanLock<T>(fn: () => Promise<T>): Promise<T> {
  if (scanLock) {
    throw new AppError(
      ErrorCodes.SCAN_IN_PROGRESS,
      "A scan is already in progress.",
      409,
    );
  }
  const run = fn();
  scanLock = run;
  try {
    return await run;
  } finally {
    scanLock = null;
  }
}

function latestSnapshot(repoId: number): SnapshotRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT branch, head_commit_sha, is_dirty, modified_count, staged_count,
                untracked_count, upstream_ref, ahead_count, behind_count, captured_at
         FROM repository_snapshots
         WHERE local_repository_id = ?
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`,
      )
      .get(repoId) as SnapshotRow | undefined) ?? null
  );
}

function snapshotDto(row: SnapshotRow | null): SnapshotDto | null {
  if (!row) return null;
  return {
    branch: row.branch,
    headCommitSha: row.head_commit_sha,
    isDirty: row.is_dirty === 1,
    modifiedCount: row.modified_count,
    stagedCount: row.staged_count,
    untrackedCount: row.untracked_count,
    upstreamRef: row.upstream_ref,
    aheadCount: row.ahead_count,
    behindCount: row.behind_count,
    capturedAt: row.captured_at,
  };
}

function githubHtmlUrlForRepo(repoId: number): string | null {
  const remotes = listRemoteRows(repoId);
  for (const remote of remotes) {
    if (remote.html_url) return remote.html_url;
    const parsed = parseGitHubRemote(remote.url);
    if (parsed) return parsed.htmlUrl;
  }
  return null;
}

function hasGitHubRemote(repoId: number): boolean {
  return githubHtmlUrlForRepo(repoId) != null;
}

function lastActivity(repoId: number): { at: string; summary: string } | null {
  const row = getDb()
    .prepare(
      `SELECT occurred_at, summary
       FROM activity_events
       WHERE local_repository_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
    )
    .get(repoId) as { occurred_at: string; summary: string } | undefined;
  return row ? { at: row.occurred_at, summary: row.summary } : null;
}

function toListItem(row: RepoRow): RepositoryListItem {
  const snap = latestSnapshot(row.id);
  const activity = lastActivity(row.id);
  const githubUrl = githubHtmlUrlForRepo(row.id);
  return {
    id: row.id,
    name: row.name,
    localPath: row.local_path,
    canonicalPath: row.canonical_path,
    discoveryType: row.discovery_type,
    sourceId: row.source_id,
    lastScannedAt: row.last_scanned_at,
    snapshot: snapshotDto(snap),
    workingTree: workingTreeTerm(snap ? snap.is_dirty === 1 : false),
    sync: syncTerm(
      snap?.upstream_ref,
      snap?.ahead_count,
      snap?.behind_count,
    ),
    github: githubTerm(githubUrl != null),
    githubHtmlUrl: githubUrl,
    lastActivityAt: activity?.at ?? row.last_scanned_at,
    lastActivitySummary: activity?.summary ?? null,
  };
}

function getRepoRow(id: number): RepoRow {
  const row = getDb()
    .prepare(
      `SELECT id, source_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at
       FROM local_repositories WHERE id = ?`,
    )
    .get(id) as RepoRow | undefined;
  if (!row) {
    throw new AppError(
      ErrorCodes.REPOSITORY_NOT_FOUND,
      "Repository was not found.",
      404,
    );
  }
  return row;
}

function findRepoByIdentity(identity: string): RepoRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, source_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at
         FROM local_repositories WHERE canonical_path = ?`,
      )
      .get(identity) as RepoRow | undefined) ?? null
  );
}

function knownCommitShas(repoId: number): Set<string> {
  const rows = getDb()
    .prepare("SELECT commit_sha FROM commits WHERE local_repository_id = ?")
    .all(repoId) as { commit_sha: string }[];
  return new Set(rows.map((row) => row.commit_sha));
}

function previousFromSnapshot(row: SnapshotRow | null): PreviousSnapshot | null {
  if (!row) return null;
  return {
    branch: row.branch,
    headCommitSha: row.head_commit_sha,
    isDirty: row.is_dirty === 1,
    upstreamRef: row.upstream_ref,
    aheadCount: row.ahead_count,
    behindCount: row.behind_count,
  };
}

function remoteHost(url: string): string | null {
  const gh = parseGitHubRemote(url);
  if (gh) return gh.host;
  try {
    if (url.startsWith("git@")) {
      const host = url.slice(4).split(":")[0];
      return host || null;
    }
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function persistInspection(
  repo: RepoRow,
  inspection: GitInspection,
  observedAt: string,
  isNew: boolean,
): void {
  const previous = previousFromSnapshot(latestSnapshot(repo.id));
  const known = knownCommitShas(repo.id);
  const events = deriveActivityEvents({
    repositoryId: repo.id,
    isNewRepository: isNew,
    previous,
    inspection,
    knownCommitShas: known,
    observedAt,
  });

  withTransaction(() => {
    const db = getDb();
    db.prepare(
      `INSERT INTO repository_snapshots (
         local_repository_id, branch, head_commit_sha, is_dirty, modified_count,
         staged_count, untracked_count, upstream_ref, ahead_count, behind_count, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      repo.id,
      inspection.branch,
      inspection.headCommitSha,
      inspection.workingTree.isDirty ? 1 : 0,
      inspection.workingTree.modifiedCount,
      inspection.workingTree.stagedCount,
      inspection.workingTree.untrackedCount,
      inspection.upstreamRef,
      inspection.aheadCount,
      inspection.behindCount,
      observedAt,
    );

    const insertCommit = db.prepare(
      `INSERT OR IGNORE INTO commits
        (local_repository_id, commit_sha, subject, author_name, committed_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const commit of inspection.recentCommits) {
      insertCommit.run(
        repo.id,
        commit.sha,
        commit.subject,
        commit.authorName,
        commit.committedAt || null,
        observedAt,
      );
    }

    const seenNames = new Set<string>();
    const upsertRemote = db.prepare(
      `INSERT INTO git_remotes (
         local_repository_id, name, url, host, owner, repository_name,
         github_repository_id, is_primary, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(local_repository_id, name) DO UPDATE SET
         url = excluded.url,
         host = excluded.host,
         owner = excluded.owner,
         repository_name = excluded.repository_name,
         is_primary = excluded.is_primary,
         last_seen_at = excluded.last_seen_at`,
    );

    const primaryName =
      inspection.remotes.find((remote) => remote.name === "origin")?.name ??
      inspection.remotes[0]?.name ??
      null;

    for (const remote of inspection.remotes) {
      seenNames.add(remote.name);
      const gh = parseGitHubRemote(remote.url);
      upsertRemote.run(
        repo.id,
        remote.name,
        remote.url,
        gh?.host ?? remoteHost(remote.url),
        gh?.owner ?? null,
        gh?.repository ?? null,
        remote.name === primaryName ? 1 : 0,
        observedAt,
      );
    }

    if (seenNames.size > 0) {
      const placeholders = [...seenNames].map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM git_remotes
         WHERE local_repository_id = ? AND name NOT IN (${placeholders})`,
      ).run(repo.id, ...seenNames);
    } else {
      db.prepare("DELETE FROM git_remotes WHERE local_repository_id = ?").run(repo.id);
    }

    db.prepare(
      "UPDATE local_repositories SET last_scanned_at = ?, name = ? WHERE id = ?",
    ).run(observedAt, repo.name, repo.id);

    persistActivityEvents(repo.id, events);
  });
}

async function enrichGitHub(repoId: number): Promise<void> {
  const remotes = listRemoteRows(repoId);
  const db = getDb();
  for (const remote of remotes) {
    const parsed = parseGitHubRemote(remote.url);
    if (!parsed) continue;
    const meta = await fetchGitHubRepoMetadata(parsed.owner, parsed.repository);
    if (!meta) continue;
    const refreshedAt = nowIso();
    const result = db
      .prepare(
        `INSERT INTO github_repositories
          (owner, name, full_name, visibility, default_branch, html_url, last_pushed_at, last_refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, name) DO UPDATE SET
           full_name = excluded.full_name,
           visibility = excluded.visibility,
           default_branch = excluded.default_branch,
           html_url = excluded.html_url,
           last_pushed_at = excluded.last_pushed_at,
           last_refreshed_at = excluded.last_refreshed_at`,
      )
      .run(
        meta.owner,
        meta.name,
        meta.fullName,
        meta.visibility,
        meta.defaultBranch,
        meta.htmlUrl,
        meta.lastPushedAt,
        refreshedAt,
      );

    const ghRow = db
      .prepare("SELECT id FROM github_repositories WHERE owner = ? AND name = ?")
      .get(meta.owner, meta.name) as { id: number } | undefined;
    const ghId = ghRow?.id ?? Number(result.lastInsertRowid);
    db.prepare(
      `UPDATE git_remotes
       SET github_repository_id = ?
       WHERE local_repository_id = ? AND name = ?`,
    ).run(ghId, repoId, remote.name);
  }
}

async function refreshRepoRow(repo: RepoRow, isNew: boolean): Promise<void> {
  const inspection = await inspectRepository(repo.local_path);
  const observedAt = nowIso();
  persistInspection(repo, inspection, observedAt, isNew);
  try {
    await enrichGitHub(repo.id);
  } catch {
    // GitHub enrichment is optional and must not break local refresh.
  }
}

function upsertDiscoveredRepo(
  readablePath: string,
  sourceId: number | null,
  discoveryType: "scanned" | "manual",
): { repo: RepoRow; isNew: boolean } {
  const identity = pathIdentity(readablePath);
  const existing = findRepoByIdentity(identity);
  if (existing) {
    if (sourceId != null && existing.source_id == null) {
      getDb()
        .prepare("UPDATE local_repositories SET source_id = ? WHERE id = ?")
        .run(sourceId, existing.id);
      return { repo: getRepoRow(existing.id), isNew: false };
    }
    return { repo: existing, isNew: false };
  }

  const createdAt = nowIso();
  const name = repositoryNameFromPath(readablePath);
  const result = getDb()
    .prepare(
      `INSERT INTO local_repositories
        (source_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(sourceId, name, readablePath, identity, discoveryType, createdAt);

  return { repo: getRepoRow(Number(result.lastInsertRowid)), isNew: true };
}

export function listRepositories(): RepositoryListItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, source_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at
       FROM local_repositories
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all() as RepoRow[];
  return rows.map(toListItem);
}

function listRemoteRows(repoId: number): RemoteRow[] {
  return getDb()
    .prepare(
      `SELECT
         r.name,
         r.url,
         r.host,
         r.owner,
         r.repository_name,
         r.is_primary,
         g.html_url
       FROM git_remotes r
       LEFT JOIN github_repositories g ON g.id = r.github_repository_id
       WHERE r.local_repository_id = ?
       ORDER BY r.is_primary DESC, r.name ASC`,
    )
    .all(repoId) as RemoteRow[];
}

function toRemoteDto(row: RemoteRow): RemoteDto {
  const parsed = parseGitHubRemote(row.url);
  const htmlUrl = row.html_url || parsed?.htmlUrl || null;
  return {
    name: row.name,
    url: row.url,
    host: row.host,
    owner: row.owner,
    repositoryName: row.repository_name,
    isPrimary: row.is_primary === 1,
    isGitHub: parsed != null,
    htmlUrl,
  };
}

function listCommits(repoId: number): CommitDto[] {
  const rows = getDb()
    .prepare(
      `SELECT commit_sha, subject, author_name, committed_at
       FROM commits
       WHERE local_repository_id = ?
       ORDER BY committed_at DESC, id DESC
       LIMIT 20`,
    )
    .all(repoId) as {
    commit_sha: string;
    subject: string;
    author_name: string | null;
    committed_at: string | null;
  }[];
  return rows.map((row) => ({
    sha: row.commit_sha,
    shortSha: row.commit_sha.slice(0, 7),
    subject: row.subject,
    authorName: row.author_name,
    committedAt: row.committed_at,
  }));
}

function githubMetadataForRepo(repoId: number): GitHubMetadataDto | null {
  const row = getDb()
    .prepare(
      `SELECT g.owner, g.name, g.full_name, g.visibility, g.default_branch, g.html_url, g.last_pushed_at
       FROM git_remotes r
       JOIN github_repositories g ON g.id = r.github_repository_id
       WHERE r.local_repository_id = ?
       ORDER BY r.is_primary DESC
       LIMIT 1`,
    )
    .get(repoId) as
    | {
        owner: string;
        name: string;
        full_name: string;
        visibility: string | null;
        default_branch: string | null;
        html_url: string;
        last_pushed_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    visibility: row.visibility,
    defaultBranch: row.default_branch,
    htmlUrl: row.html_url,
    lastPushedAt: row.last_pushed_at,
  };
}

export async function getRepositoryDetail(id: number): Promise<RepositoryDetail> {
  const item = toListItem(getRepoRow(id));
  let changedFiles: RepositoryDetail["changedFiles"] = [];
  try {
    const inspection = await inspectRepository(item.localPath);
    changedFiles = inspection.workingTree.changedFiles;
  } catch {
    changedFiles = [];
  }
  return {
    ...item,
    changedFiles,
    remotes: listRemoteRows(id).map(toRemoteDto),
    commits: listCommits(id),
    githubMetadata: githubMetadataForRepo(id),
  };
}

export async function addManualRepository(input: { path: unknown }): Promise<RepositoryDetail> {
  return withScanLock(async () => {
    const { readable } = resolveExistingDirectory(input.path);
    const identity = pathIdentity(readable);
    const existing = findRepoByIdentity(identity);
    if (existing) {
      throw new AppError(
        ErrorCodes.REPOSITORY_ALREADY_TRACKED,
        "That Git repository is already tracked.",
      );
    }
    const isRepo = await isRepository(readable);
    if (!isRepo) {
      throw new AppError(
        ErrorCodes.NOT_GIT_REPOSITORY,
        "The selected folder is not a Git repository.",
      );
    }
    const { repo, isNew } = upsertDiscoveredRepo(readable, null, "manual");
    await refreshRepoRow(repo, isNew);
    return getRepositoryDetail(repo.id);
  });
}

export function deleteRepository(id: number): void {
  getRepoRow(id);
  getDb().prepare("DELETE FROM local_repositories WHERE id = ?").run(id);
}

export async function refreshRepository(id: number): Promise<RepositoryDetail> {
  return withScanLock(async () => {
    const repo = getRepoRow(id);
    const isRepo = await isRepository(repo.local_path);
    if (!isRepo) {
      throw new AppError(
        ErrorCodes.NOT_GIT_REPOSITORY,
        "The selected folder is not a Git repository.",
      );
    }
    await refreshRepoRow(repo, false);
    return getRepositoryDetail(id);
  });
}

async function scanSourceById(sourceId: number): Promise<{
  discovered: number;
  refreshed: number;
}> {
  const source = getSource(sourceId);
  const found = findGitRepositories(source.path, source.scanDepth);
  let discovered = 0;
  let refreshed = 0;
  for (const repoPath of found) {
    try {
      const isRepo = await isRepository(repoPath);
      if (!isRepo) continue;
      const { repo, isNew } = upsertDiscoveredRepo(repoPath, sourceId, "scanned");
      if (isNew) discovered += 1;
      await refreshRepoRow(repo, isNew);
      refreshed += 1;
    } catch {
      // Skip individual repositories that cannot be inspected.
    }
  }
  markSourceScanned(sourceId, nowIso());
  return { discovered, refreshed };
}

export async function scanSource(sourceId: number): Promise<ScanSummary> {
  return withScanLock(async () => {
    getSource(sourceId);
    const result = await scanSourceById(sourceId);
    return {
      sourcesScanned: 1,
      repositoriesDiscovered: result.discovered,
      repositoriesRefreshed: result.refreshed,
    };
  });
}

export async function scanAllSources(): Promise<ScanSummary> {
  return withScanLock(async () => {
    const sources = listEnabledSources();
    let discovered = 0;
    let refreshed = 0;
    for (const source of sources) {
      const result = await scanSourceById(source.id);
      discovered += result.discovered;
      refreshed += result.refreshed;
    }
    return {
      sourcesScanned: sources.length,
      repositoriesDiscovered: discovered,
      repositoriesRefreshed: refreshed,
    };
  });
}

export function listActivity(filters: {
  repositoryId?: number;
  from?: string;
  to?: string;
}): ActivityEventDto[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filters.repositoryId != null) {
    clauses.push("e.local_repository_id = ?");
    params.push(filters.repositoryId);
  }
  if (filters.from) {
    clauses.push("e.occurred_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("e.occurred_at <= ?");
    params.push(filters.to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT
         e.id,
         e.local_repository_id,
         lr.name AS project_name,
         e.event_type,
         e.summary,
         e.occurred_at,
         e.source
       FROM activity_events e
       JOIN local_repositories lr ON lr.id = e.local_repository_id
       ${where}
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT 200`,
    )
    .all(...params) as ActivityRow[];
  return rows.map((row) => ({
    id: row.id,
    localRepositoryId: row.local_repository_id,
    projectName: row.project_name,
    eventType: row.event_type,
    summary: row.summary,
    occurredAt: row.occurred_at,
    source: row.source,
  }));
}

function weekAgoIso(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

function needsAttention(item: RepositoryListItem): boolean {
  if (item.workingTree === "Uncommitted") return true;
  const ahead = item.snapshot?.aheadCount ?? 0;
  const behind = item.snapshot?.behindCount ?? 0;
  return ahead > 0 || behind > 0;
}

export function getDashboard(): DashboardResponse {
  const repos = listRepositories();
  const since = weekAgoIso();
  const weekActivity = listActivity({ from: since });
  const qualifying = new Set<string>(QUALIFYING_ACTIVITY_TYPES);
  const activeIds = new Set(
    weekActivity
      .filter((event) => qualifying.has(event.eventType))
      .map((event) => event.localRepositoryId),
  );
  const commitsThisWeek = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM commits
         WHERE committed_at IS NOT NULL AND committed_at >= ?`,
      )
      .get(since) as { n: number }
  ).n;

  const attention = repos.filter(needsAttention);
  const recentProjects = [...repos].sort((a, b) => {
    const at = a.lastActivityAt || a.lastScannedAt || "";
    const bt = b.lastActivityAt || b.lastScannedAt || "";
    return bt.localeCompare(at);
  });

  return {
    trackedProjects: repos.length,
    uncommittedProjects: repos.filter((repo) => repo.workingTree === "Uncommitted")
      .length,
    activeThisWeek: activeIds.size,
    commitsThisWeek,
    needsAttention: attention.slice(0, 20),
    recentProjects: recentProjects.slice(0, 8),
    recentActivity: listActivity({}).slice(0, 10),
  };
}

export { hasGitHubRemote };
