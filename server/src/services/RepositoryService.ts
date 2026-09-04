import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ActivityEventDto,
  CommitDto,
  DashboardResponse,
  DeleteLocalBindingResponse,
  GitHubMetadataDto,
  RemoteDto,
  RepositoryDetail,
  RepositoryListItem,
  ScanSummary,
  SnapshotDto,
  ProjectStatus,
  ProjectType,
  RecentlyActiveProjectDto,
  AttentionReason,
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
  listActivity as listActivityProjectAware,
  type PreviousSnapshot,
} from "./ActivityService.js";
import {
  ensureSinglePrimary,
  finalizeProjectAfterFinalBindingRemoval,
} from "./ProjectService.js";
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
  project_id: number | null;
  /** V1.2 M1: explicit display-primary flag (server-authoritative). */
  is_primary: number;
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
    /**
     * V1.2 M1: the server-resolved EFFECTIVE primary for the owning
     * project (explicit is_primary = 1, else the deterministic MIN(id)
     * fallback for zero-primary repair states). Clients consume the
     * resulting boolean; they never derive a primary themselves.
     */
    effectivePrimaryId: number | null;
    project?: {
      project_status: ProjectStatus | null;
      project_type: ProjectType | null;
      project_note: string | null;
      include_in_portfolio: number;
      portfolio_order: number | null;
    } | null;
  },
): RepositoryListItem {
  const snap = ctx.snap;
  const activity = ctx.activity;
  const githubUrl = ctx.githubUrl;
  // V1.1: manual metadata lives on the Project; binding-level columns are
  // vestigial and only used as a fallback when no project row resolves.
  const meta = ctx.project ?? {
    project_status: row.project_status,
    project_type: row.project_type,
    project_note: row.project_note,
    include_in_portfolio: row.include_in_portfolio,
    portfolio_order: row.portfolio_order,
  };
  return {
    id: row.id,
    projectId: row.project_id,
    // V1.2 M1: server-authoritative EFFECTIVE display primary — the
    // explicit flag when present, else the deterministic MIN(id) fallback
    // (owner decision D1 read rule). Clients must use this instead of
    // first-row/name-order heuristics.
    isPrimary: ctx.effectivePrimaryId === row.id,
    name: row.name,
    localPath: row.local_path,
    canonicalPath: row.canonical_path,
    discoveryType: row.discovery_type,
    sourceId: row.source_id,
    lastScannedAt: row.last_scanned_at,
    snapshot: snapshotDto(snap),
    projectStatus: meta.project_status,
    projectType: meta.project_type,
    projectNote: meta.project_note,
    includeInPortfolio: meta.include_in_portfolio === 1,
    portfolioOrder: meta.portfolio_order,
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
      `SELECT id, source_id, project_id, is_primary, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at, project_status, project_type, project_note, include_in_portfolio, portfolio_order
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
        `SELECT id, source_id, project_id, is_primary, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at, project_status, project_type, project_note, include_in_portfolio, portfolio_order
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
      // V1.2 M2-F: a successful explicit inspection is a live Git verdict —
      // cache it as OK as of this observation (alongside last_scanned_at).
      "UPDATE local_repositories SET last_scanned_at = ?, name = ?, last_health_state = 'OK', last_health_checked_at = ? WHERE id = ?",
    ).run(observedAt, repo.name, observedAt, repo.id);

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
  // Reverse match FIRST: a fresh clone whose remote identity matches an
  // already-tracked GitHub-only project must be adopted before its commits
  // are persisted, so the pristine-project merge condition still holds.
  reconcileTrackedIdentity(repo.id, repo.canonical_path);
  const inspection = await inspectRepository(repo.local_path);
  const observedAt = nowIso();
  persistInspection(repo, inspection, observedAt, isNew);
  reconcileTrackedIdentity(repo.id, repo.canonical_path);
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
  const db = getDb();

  // Every binding must belong to a project (004 invariant). A brand-new
  // local repository starts as its own project; reconcileTrackedIdentity()
  // below may later merge it into an already-tracked GitHub-only project.
  const projectResult = db
    .prepare(
      `INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)`,
    )
    .run(name, createdAt, createdAt);
  const projectId = Number(projectResult.lastInsertRowid);

  const result = db
    .prepare(
      `INSERT INTO local_repositories
        (source_id, project_id, is_primary, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at)
       VALUES (?, ?,
         -- V1.2 M1 new-binding invariant: the first local binding of a
         -- project is explicitly its display primary (no DEFAULT-0 +
         -- read-fallback reliance for newly created projects). Subquery
         -- covers the pre-existing-bindings case; 1 for a brand-new project.
         CASE WHEN EXISTS (
           SELECT 1 FROM local_repositories lr2 WHERE lr2.project_id = ?
         ) THEN 0 ELSE 1 END,
         ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      sourceId,
      projectId,
      projectId,
      name,
      readablePath,
      identity,
      discoveryType,
      createdAt,
    );

  return { repo: getRepoRow(Number(result.lastInsertRowid)), isNew: true };
}

/**
 * Reverse match (V1.1): after a binding's remotes are persisted, if one of
 * them matches an already-tracked GitHub binding's identity, move this
 * binding into that project — upgrading GITHUB ONLY to LOCAL + GITHUB
 * without duplicating anything. Only merges when the freshly discovered
 * project is still empty (single fresh binding, no metadata/history), so
 * user-curated projects are never silently absorbed.
 */
function reconcileTrackedIdentity(repoId: number, canonicalPath: string): void {
  const db = getDb();
  const mine = db
    .prepare(
      `SELECT lr.project_id AS projectId, r.url
       FROM local_repositories lr
       LEFT JOIN git_remotes r ON r.local_repository_id = lr.id
       WHERE lr.id = ?`,
    )
    .all(repoId) as Array<{ projectId: number | null; url: string | null }>;
  const currentProjectId = mine[0]?.projectId;
  if (currentProjectId == null) return;

  for (const row of mine) {
    if (!row.url) continue;
    const parsed = parseGitHubRemote(row.url);
    if (!parsed) continue;
    const tracked = db
      .prepare(
        `SELECT id, project_id FROM github_repositories
         WHERE owner_norm = lower(?) AND name_norm = lower(?) AND project_id IS NOT NULL`,
      )
      .get(parsed.owner, parsed.repository) as
      | { id: number; project_id: number }
      | undefined;
    if (!tracked || tracked.project_id === currentProjectId) continue;

    // Merge only a pristine auto-created project: no OTHER bindings and no
    // user-authored metadata. The fresh binding's own commits/events move
    // with it — they are this repository's history and belong to the target.
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM local_repositories WHERE project_id = ? AND id != ?) AS otherLocals,
           (SELECT include_in_portfolio + COALESCE(project_status IS NOT NULL, 0)
              + COALESCE(project_type IS NOT NULL, 0) + COALESCE(project_note IS NOT NULL, 0)
            FROM projects WHERE id = ?) AS meta`,
      )
      .get(currentProjectId, repoId, currentProjectId) as {
      otherLocals: number;
      meta: number;
    };
    if (counts.otherLocals > 0 || counts.meta > 0) {
      continue;
    }

    withTransaction(() => {
      // V1.2 M1: move the incoming binding with is_primary=0 unconditionally
      // — idx_local_repo_project_primary enforces at most one is_primary=1
      // per project, and the incoming binding (always the highest id) must
      // NEVER override the target's chosen primary, including the
      // deterministic MIN(id) fallback in a zero-explicit-primary repair
      // state. ensureSinglePrimary below settles ownership.
      db.prepare(
        "UPDATE local_repositories SET project_id = ?, is_primary = 0 WHERE id = ?",
      ).run(tracked.project_id, repoId);
      db.prepare("UPDATE activity_events SET project_id = ? WHERE project_id = ?").run(
        tracked.project_id,
        currentProjectId,
      );
      db.prepare("DELETE FROM projects WHERE id = ?").run(currentProjectId);
      // Primary ownership settles here, still inside the merge transaction:
      // an explicit primary stays untouched; a target with locals but zero
      // explicit primary repairs to MIN(id); a GitHub-only target makes the
      // incoming binding its first primary (new-binding invariant).
      ensureSinglePrimary(tracked.project_id);
    });
    return;
  }
}

/**
 * V1.2 M1: effective-primary resolver for one row's owning project —
 * explicit is_primary = 1 first, else the deterministic MIN(id) fallback
 * (zero-primary repair states never surface as primary-less). Mirrors the
 * semantics of primaryLocalBindingId in ProjectService (owner decision D1
 * read rule) without introducing a service import cycle.
 */
function effectivePrimaryIdFor(row: RepoRow): number | null {
  if (row.project_id == null) return null;
  const found = getDb()
    .prepare(
      `SELECT id FROM local_repositories
       WHERE project_id = ?
       ORDER BY is_primary DESC, id ASC
       LIMIT 1`,
    )
    .get(row.project_id) as { id: number } | undefined;
  return found?.id ?? null;
}

export function listRepositories(): RepositoryListItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, source_id, project_id, is_primary, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at, project_status, project_type, project_note, include_in_portfolio, portfolio_order
       FROM local_repositories
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all() as RepoRow[];
  // Batch effective-primary resolution from the already-fetched rows:
  // explicit flag wins (lowest id in degenerate states), else MIN(id) per
  // project — identical ordering semantics to effectivePrimaryIdFor.
  const explicit = new Map<number, number>();
  const lowest = new Map<number, number>();
  for (const row of rows) {
    if (row.project_id == null) continue;
    const currentExplicit = explicit.get(row.project_id);
    if (row.is_primary === 1 && (currentExplicit == null || row.id < currentExplicit)) {
      explicit.set(row.project_id, row.id);
    }
    const currentLowest = lowest.get(row.project_id);
    if (currentLowest == null || row.id < currentLowest) {
      lowest.set(row.project_id, row.id);
    }
  }
  const effectivePrimary = (projectId: number): number | null =>
    explicit.get(projectId) ?? lowest.get(projectId) ?? null;
  const context = buildListItemContext(rows.map((row) => row.id));
  return rows.map((row) =>
    toListItem(row, {
      ...(context.get(row.id) ?? { snap: null, activity: null, githubUrl: null, project: null }),
      effectivePrimaryId: effectivePrimary(row.project_id as number),
    }),
  );
}

/**
 * Batched variant for list-heavy endpoints (Projects page, Dashboard):
 * one grouped query per data family instead of three queries per row,
 * keeping large workspaces (100+ repositories) responsive.
 */
function buildListItemContext(
  repoIds: number[],
): Map<
  number,
  {
    snap: SnapshotRow | null;
    activity: { at: string; summary: string } | null;
    githubUrl: string | null;
    project: {
      project_status: ProjectStatus | null;
      project_type: ProjectType | null;
      project_note: string | null;
      include_in_portfolio: number;
      portfolio_order: number | null;
    } | null;
  }
> {
  const db = getDb();
  const ctx = new Map<
    number,
    {
      snap: SnapshotRow | null;
      activity: { at: string; summary: string } | null;
      githubUrl: string | null;
      project: {
        project_status: ProjectStatus | null;
        project_type: ProjectType | null;
        project_note: string | null;
        include_in_portfolio: number;
        portfolio_order: number | null;
      } | null;
    }
  >();
  if (repoIds.length === 0) return ctx;

  // V1.1: project-owned metadata for each binding (single batched query).
  const projects = db
    .prepare(
      `SELECT lr.id AS rid, p.project_status, p.project_type,
              p.project_note, p.include_in_portfolio, p.portfolio_order
       FROM local_repositories lr
       JOIN projects p ON p.id = lr.project_id
       WHERE lr.id IN (${repoIds.map(() => "?").join(",")})`,
    )
    .all(...repoIds) as Array<{
    rid: number;
    project_status: ProjectStatus | null;
    project_type: ProjectType | null;
    project_note: string | null;
    include_in_portfolio: number;
    portfolio_order: number | null;
  }>;
  for (const project of projects) {
    const entry = ctx.get(project.rid) ?? {
      snap: null,
      activity: null,
      githubUrl: null,
      project: null,
    };
    entry.project = {
      project_status: project.project_status,
      project_type: project.project_type,
      project_note: project.project_note,
      include_in_portfolio: project.include_in_portfolio,
      portfolio_order: project.portfolio_order,
    };
    ctx.set(project.rid, entry);
  }

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
    const entry = ctx.get(snap.rid) ?? {
      snap: null,
      activity: null,
      githubUrl: null,
      project: null,
    };
    entry.snap = (({ rid: _rid, ...rest }) => rest)(snap) as SnapshotRow;
    ctx.set(snap.rid, entry);
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
    const entry = ctx.get(activity.rid) ?? { snap: null, activity: null, githubUrl: null, project: null };
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
    const entry = ctx.get(remote.rid) ?? { snap: null, activity: null, githubUrl: null, project: null };
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
  const item = toListItem(row, {
    ...(context.get(row.id) ?? { snap: null, activity: null, githubUrl: null, project: null }),
    effectivePrimaryId: effectivePrimaryIdFor(row),
  });
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

/**
 * Remove a local binding ("Remove from dashboard" / Sources row Remove).
 * The filesystem folder is NEVER touched — this deletes a database row.
 *
 * Q1 invariant applies to the owning Project exactly like GitHub untrack:
 * - another binding remains -> project survives unchanged;
 * - final binding + empty project -> project auto-deletes;
 * - final binding + meaningful state -> refuses with PROJECT_HAS_NO_SOURCES
 *   so the client can ask keep-or-delete before destroying the Project.
 */
export function deleteRepository(
  id: number,
  options: { confirmDeleteProject?: boolean } = {},
): DeleteLocalBindingResponse {
  const repo = getRepoRow(id);
  const projectId = repo.project_id;
  if (projectId == null) {
    // Pre-004 legacy row without a project mapping: remove the binding only.
    getDb().prepare("DELETE FROM local_repositories WHERE id = ?").run(id);
    return { ok: true, projectDeleted: false };
  }
  return withTransaction(() => {
    const wasPrimary = repo.is_primary === 1;
    getDb().prepare("DELETE FROM local_repositories WHERE id = ?").run(id);
    // V1.2 M1: if the removed binding was the display primary and another
    // local binding remains, promote MIN(id) of the survivors to is_primary=1
    // BEFORE the transaction completes (owner decision D2). If it was not
    // primary, the explicit primary remains untouched. The defensive
    // repair at the end covers any manual/partial state.
    if (wasPrimary) {
      // Owner decision D2: promote the lowest surviving binding id to
      // display primary IN THE SAME TRANSACTION; MIN(id) reproduces the
      // V1.1 effective-primary rule byte-for-byte.
      getDb()
        .prepare(
          `UPDATE local_repositories SET is_primary = CASE WHEN id = (
             SELECT MIN(id) FROM local_repositories WHERE project_id = ?
           ) THEN 1 ELSE 0 END
           WHERE project_id = ?`,
        )
        .run(projectId, projectId);
    }
    // Defensive backstop (no-op when exactly one explicit primary already
    // exists): covers manual/partial states and pre-008 rows.
    ensureSinglePrimary(projectId);
    // Binding-level snapshots/commits/remotes cascade with the FK; events
    // survive as project-scoped rows and count toward meaningfulness below.
    return {
      ok: true,
      projectDeleted: finalizeProjectAfterFinalBindingRemoval(projectId, options)
        .projectDeleted,
    };
  });
}

export async function refreshRepository(id: number): Promise<RepositoryDetail> {
  return withScanLock(async () => {
    const repo = getRepoRow(id);
    // V1.2 M2-G: honesty for explicit refreshes. A missing tracked folder is
    // PATH_NOT_FOUND, not a Git verdict — Git must not even be spawned when
    // existence has already failed. (A present directory that fails Git
    // worktree validation stays NOT_GIT_REPOSITORY below.)
    if (!fs.existsSync(repo.local_path)) {
      throw new AppError(
        ErrorCodes.PATH_NOT_FOUND,
        "The repository folder was not found on disk.",
        404,
      );
    }
    const isRepo = await isRepository(repo.local_path);
    if (!isRepo) {
      // V1.2 M2-F: the path exists but explicit Git validation failed —
      // cache that verdict as of now, keep last_scanned_at and the last
      // valid historical snapshot untouched, write no fake snapshot, then
      // surface the existing NOT_GIT_REPOSITORY error.
      getDb()
        .prepare(
          "UPDATE local_repositories SET last_health_state = 'NOT_A_GIT_REPO', last_health_checked_at = ? WHERE id = ?",
        )
        .run(nowIso(), id);
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
  projectId?: number;
  from?: string;
  to?: string;
}): ActivityEventDto[] {
  // V1.1: delegated to the project-aware implementation in ActivityService
  // so GitHub-origin events appear alongside local ones.
  return listActivityProjectAware(filters);
}

function weekAgoIso(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export function getDashboard(): DashboardResponse {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, source_id, project_id, is_primary, name, local_path, canonical_path, discovery_type, created_at, last_scanned_at, project_status, project_type, project_note, include_in_portfolio, portfolio_order
       FROM local_repositories
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all() as RepoRow[];
  const context = buildListItemContext(rows.map((row) => row.id));
  const since = weekAgoIso();
  const qualifying = new Set<string>(QUALIFYING_ACTIVITY_TYPES);

  // --- summary metrics (all real values) ---
  const weekActivity = listActivity({ from: since });
  const activeIds = new Set(
    weekActivity
      .filter((event) => qualifying.has(event.eventType))
      .map((event) => event.localRepositoryId),
  );
  const commitsThisWeek = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT commit_sha) AS n FROM commits
         WHERE committed_at IS NOT NULL AND committed_at >= ?`,
      )
      .get(since) as { n: number }
  ).n;
  const activeDaysThisWeek = new Set(
    weekActivity
      .filter((event) => qualifying.has(event.eventType))
      .map((event) => event.occurredAt.slice(0, 10)),
  ).size;

  // --- recently active projects: meaningful events only (spec sections 5.2, 8.2) ---
  type MeaningfulRow = { rid: number; last_meaningful_at: string };
  const meaningfulRows = db
    .prepare(
      `SELECT e.local_repository_id AS rid, MAX(e.occurred_at) AS last_meaningful_at
       FROM activity_events e
       WHERE e.event_type IN (${[...qualifying].map(() => "?").join(",")})
       GROUP BY e.local_repository_id`,
    )
    .all(...qualifying) as MeaningfulRow[];
  const meaningfulByRepo = new Map(meaningfulRows.map((row) => [row.rid, row.last_meaningful_at]));
  const latestCommitByRepo = new Map<number, string>();
  for (const row of rows) {
    const commit = db
      .prepare(
        `SELECT subject FROM commits
         WHERE local_repository_id = ? AND committed_at IS NOT NULL
         ORDER BY committed_at DESC, id DESC LIMIT 1`,
      )
      .get(row.id) as { subject: string } | undefined;
    if (commit) latestCommitByRepo.set(row.id, commit.subject);
  }

  function compactDto(row: RepoRow): RecentlyActiveProjectDto & {
    snapshotCounts: { modified: number; staged: number; untracked: number } | null;
    attentionReasons?: AttentionReason[];
  } {
    const ctx = context.get(row.id);
    const snap = ctx?.snap ?? null;
    const dirty = snap?.is_dirty === 1;
    const ahead = snap?.ahead_count ?? null;
    const behind = snap?.behind_count ?? null;
    const upstreamRef = snap?.upstream_ref ?? null;
    const pathExists = fs.existsSync(row.local_path);
    const githubConnected = (ctx?.githubUrl ?? null) != null;

    const reasons: AttentionReason[] = [];
    if (!pathExists) reasons.push("repository path unavailable");
    if (dirty) reasons.push("uncommitted changes");
    if (upstreamRef == null) {
      reasons.push("no upstream branch");
    } else if ((ahead ?? 0) > 0 && (behind ?? 0) > 0) {
      reasons.push("ahead and behind upstream");
    } else if ((ahead ?? 0) > 0) {
      reasons.push("ahead of upstream");
    } else if ((behind ?? 0) > 0) {
      reasons.push("behind upstream");
    }

    return {
      id: row.id,
      name: row.name,
      projectStatus: row.project_status,
      projectType: row.project_type,
      branch: snap?.branch ?? null,
      workingTree: dirty ? "Uncommitted" : "Clean",
      sync: syncTerm(upstreamRef, ahead, behind),
      githubConnected,
      localPath: row.local_path,
      lastMeaningfulAt: meaningfulByRepo.get(row.id) ?? null,
      latestCommitSubject: latestCommitByRepo.get(row.id) ?? null,
      snapshotCounts: snap
        ? {
            modified: snap.modified_count,
            staged: snap.staged_count,
            untracked: snap.untracked_count,
          }
        : null,
      attentionReasons: reasons,
    } as RecentlyActiveProjectDto & {
      snapshotCounts: { modified: number; staged: number; untracked: number } | null;
      attentionReasons?: AttentionReason[];
    };
  }

  const compact = rows.map(compactDto);

  const recentlyActive = [...compact]
    .sort((a, b) => (b.lastMeaningfulAt ?? "").localeCompare(a.lastMeaningfulAt ?? ""))
    .slice(0, 8);

  const needsAttention = compact
    .filter((item) => (item.attentionReasons?.length ?? 0) > 0)
    .slice(0, 20)
    .map((item) => ({
      ...item,
      attentionReasons: item.attentionReasons ?? [],
    }));

  return {
    trackedProjects: rows.length,
    activeProjects: activeIds.size,
    commitsThisWeek,
    activeDaysThisWeek,
    uncommittedRepositories: compact.filter((item) => item.workingTree === "Uncommitted").length,
    recentlyActive,
    needsAttention,
    recentActivity: listActivity({}).slice(0, 10),
  };
}

/** Test seam: identical to getDashboard but exported without route wiring. */
export const getDashboardForTest = getDashboard;

export { hasGitHubRemote };
