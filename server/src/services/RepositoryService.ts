import { createHash } from "node:crypto";
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
  ProjectStatus,
  ProjectType,
  UpdateMetadataRequest,
} from "../../../shared/api-types.js";
import { PROJECT_STATUSES, PROJECT_TYPES } from "../../../shared/api-types.js";
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
  project_status: ProjectStatus | null;
  project_type: ProjectType | null;
  project_note: string | null;
  include_in_portfolio: number;
  portfolio_order: number | null;
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

function toListItem(
  row: RepoRow,
  ctx: {
    snap: SnapshotRow | null;
    activity: { at: string; summary: string } | null;
    githubUrl: string | null;
  },
): RepositoryListItem {
  const snap = ctx.snap;
  const activity = ctx.activity;
  const githubUrl = ctx.githubUrl;
  return {
    id: row.id,
    name: row.name,
    localPath: row.local_path,
    canonicalPath: row.canonical_path,
    discoveryType: row.discovery_type,
    sourceId: row.source_id,
    lastScannedAt: row.last_scanned_at,
    snapshot: snapshotDto(snap),
    projectStatus: row.project_status,
    projectType: row.project_type,
    projectNote: row.project_note,
    includeInPortfolio: row.include_in_portfolio === 1,
    portfolioOrder: row.portfolio_order,
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
      `SELECT id, source_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at, project_status, project_type, project_note, include_in_portfolio, portfolio_order
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
        `SELECT id, source_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at, project_status, project_type, project_note, include_in_portfolio, portfolio_order
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
      `SELECT id, source_id, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at, project_status, project_type, project_note, include_in_portfolio, portfolio_order
       FROM local_repositories
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all() as RepoRow[];
  const context = buildListItemContext(rows.map((row) => row.id));
  return rows.map((row) =>
    toListItem(
      row,
      context.get(row.id) ?? { snap: null, activity: null, githubUrl: null },
    ),
  );
}

/**
 * Batched variant for list-heavy endpoints (Projects page, Dashboard):
 * one grouped query per data family instead of three queries per row,
 * keeping large workspaces (100+ repositories) responsive.
 */
function buildListItemContext(
  repoIds: number[],
): Map<number, { snap: SnapshotRow | null; activity: { at: string; summary: string } | null; githubUrl: string | null }> {
  const db = getDb();
  const ctx = new Map<
    number,
    { snap: SnapshotRow | null; activity: { at: string; summary: string } | null; githubUrl: string | null }
  >();
  if (repoIds.length === 0) return ctx;

  // Latest snapshot per repository (correlated MAX(id) — snapshot ids are monotonic).
  const snaps = db
    .prepare(
      `SELECT s.local_repository_id AS rid, s.branch, s.head_commit_sha, s.is_dirty,
              s.modified_count, s.staged_count, s.untracked_count, s.upstream_ref,
              s.ahead_count, s.behind_count, s.captured_at
       FROM repository_snapshots s
       JOIN (
         SELECT local_repository_id, MAX(id) AS max_id
         FROM repository_snapshots
         WHERE local_repository_id IN (${repoIds.map(() => "?").join(",")})
         GROUP BY local_repository_id
       ) latest ON latest.max_id = s.id`,
    )
    .all(...repoIds) as (SnapshotRow & { rid: number })[];
  for (const snap of snaps) {
    ctx.set(snap.rid, {
      snap: (({ rid: _rid, ...rest }) => rest)(snap) as SnapshotRow,
      activity: null,
      githubUrl: null,
    });
  }

  // Latest activity per repository.
  const activities = db
    .prepare(
      `SELECT e.local_repository_id AS rid, e.occurred_at, e.summary
       FROM activity_events e
       JOIN (
         SELECT local_repository_id, MAX(id) AS max_id
         FROM activity_events
         WHERE local_repository_id IN (${repoIds.map(() => "?").join(",")})
         GROUP BY local_repository_id
       ) latest ON latest.max_id = e.id`,
    )
    .all(...repoIds) as { rid: number; occurred_at: string; summary: string }[];
  for (const activity of activities) {
    const entry = ctx.get(activity.rid) ?? { snap: null, activity: null, githubUrl: null };
    entry.activity = { at: activity.occurred_at, summary: activity.summary };
    ctx.set(activity.rid, entry);
  }

  // First recognized GitHub URL per repository (primary remote first).
  const remotes = db
    .prepare(
      `SELECT r.local_repository_id AS rid, r.url, g.html_url
       FROM git_remotes r
       LEFT JOIN github_repositories g ON g.id = r.github_repository_id
       WHERE r.local_repository_id IN (${repoIds.map(() => "?").join(",")})
       ORDER BY r.is_primary DESC, r.name ASC`,
    )
    .all(...repoIds) as { rid: number; url: string; html_url: string | null }[];
  for (const remote of remotes) {
    const entry = ctx.get(remote.rid) ?? { snap: null, activity: null, githubUrl: null };
    if (entry.githubUrl == null) {
      const parsed = parseGitHubRemote(remote.url);
      entry.githubUrl = remote.html_url ?? parsed?.htmlUrl ?? null;
    }
  }
  return ctx;
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
  const row = getRepoRow(id);
  const context = buildListItemContext([row.id]);
  const item = toListItem(
    row,
    context.get(row.id) ?? { snap: null, activity: null, githubUrl: null },
  );
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

const METADATA_ERROR =
  "Metadata is invalid. Provide valid projectStatus/projectType values, a note of at most 500 characters, and a boolean portfolio flag.";

function metadataError(): AppError {
  return new AppError(ErrorCodes.INVALID_METADATA, METADATA_ERROR);
}

type MetadataChange = {
  eventType: "project_status_changed" | "project_note_updated";
  summary: string;
  fingerprint: string;
  metadata: Record<string, unknown>;
};

export async function updateMetadata(
  id: number,
  input: unknown,
): Promise<RepositoryDetail> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw metadataError();
  }
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body);
  const allowed = [
    "projectStatus",
    "projectType",
    "projectNote",
    "includeInPortfolio",
    "portfolioOrder",
  ];
  if (keys.some((key) => !allowed.includes(key))) {
    throw metadataError();
  }

  // Validate everything before touching the database or emitting events.
  let nextStatus: ProjectStatus | null | undefined;
  if (body.projectStatus !== undefined) {
    if (body.projectStatus === null) {
      nextStatus = null;
    } else if (
      typeof body.projectStatus === "string" &&
      (PROJECT_STATUSES as readonly string[]).includes(body.projectStatus)
    ) {
      nextStatus = body.projectStatus as ProjectStatus;
    } else {
      throw metadataError();
    }
  }

  let nextType: ProjectType | null | undefined;
  if (body.projectType !== undefined) {
    if (body.projectType === null) {
      nextType = null;
    } else if (
      typeof body.projectType === "string" &&
      (PROJECT_TYPES as readonly string[]).includes(body.projectType)
    ) {
      nextType = body.projectType as ProjectType;
    } else {
      throw metadataError();
    }
  }

  let nextNote: string | null | undefined;
  if (body.projectNote !== undefined) {
    if (body.projectNote === null) {
      nextNote = null;
    } else if (typeof body.projectNote === "string") {
      const trimmed = body.projectNote.trim();
      if (trimmed.length > 500) throw metadataError();
      nextNote = trimmed.length > 0 ? trimmed : null;
    } else {
      throw metadataError();
    }
  }

  let nextInclude: boolean | undefined;
  if (body.includeInPortfolio !== undefined) {
    if (typeof body.includeInPortfolio === "boolean") {
      nextInclude = body.includeInPortfolio;
    } else {
      throw metadataError();
    }
  }

  let nextOrder: number | null | undefined;
  if (body.portfolioOrder !== undefined) {
    if (body.portfolioOrder === null) {
      nextOrder = null;
    } else if (
      typeof body.portfolioOrder === "number" &&
      Number.isInteger(body.portfolioOrder)
    ) {
      nextOrder = body.portfolioOrder;
    } else {
      throw metadataError();
    }
  }

  return withScanLock(async () => {
    const repo = getRepoRow(id);
    const changes: MetadataChange[] = [];
    const observedAt = nowIso();

    if (nextStatus !== undefined && nextStatus !== repo.project_status) {
      changes.push({
        eventType: "project_status_changed",
        summary: `Project status changed from ${repo.project_status ?? "—"} to ${nextStatus ?? "—"}`,
        fingerprint: `${repo.id}:project_status_changed:${repo.project_status ?? "none"}->${nextStatus ?? "none"}`,
        metadata: { from: repo.project_status, to: nextStatus },
      });
    }

    if (nextNote !== undefined && nextNote !== repo.project_note) {
      const digest = createHash("sha256").update(nextNote ?? "").digest("hex").slice(0, 12);
      changes.push({
        eventType: "project_note_updated",
        summary: `Project note updated${nextNote ? `: ${nextNote}` : ""}`,
        fingerprint: `${repo.id}:project_note_updated:${digest}`,
        metadata: { length: (nextNote ?? "").length },
      });
    }

    withTransaction(() => {
      const db = getDb();

      if (changes.length > 0) {
        persistActivityEvents(
          repo.id,
          changes.map((change) => ({
            eventType: change.eventType,
            summary: change.summary,
            occurredAt: observedAt,
            fingerprint: change.fingerprint,
            metadata: change.metadata,
          })),
        );
      }

      db.prepare(
        `UPDATE local_repositories SET
           project_status = CASE WHEN ?1 THEN ?2 ELSE project_status END,
           project_type   = CASE WHEN ?3 THEN ?4 ELSE project_type END,
           project_note   = CASE WHEN ?5 THEN ?6 ELSE project_note END,
           include_in_portfolio = CASE WHEN ?7 THEN ?8 ELSE include_in_portfolio END,
           portfolio_order = CASE WHEN ?9 THEN ?10 ELSE portfolio_order END
         WHERE id = ?11`,
      ).run(
        nextStatus !== undefined ? 1 : 0,
        nextStatus ?? null,
        nextType !== undefined ? 1 : 0,
        nextType ?? null,
        nextNote !== undefined ? 1 : 0,
        nextNote ?? null,
        nextInclude !== undefined ? 1 : 0,
        nextInclude === true ? 1 : 0,
        nextOrder !== undefined ? 1 : 0,
        nextOrder ?? null,
        repo.id,
      );
    });

    return getRepositoryDetail(id);
  });
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
