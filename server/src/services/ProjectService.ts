import type {
  GitHubMetadataDto,
  ProjectLocalBindingDto,
  SetPrimaryLocalBindingResponse,
  ProjectStatus,
  ProjectType,
  SnapshotDto,
  SourceState,
} from "../../../shared/api-types.js";
import { PROJECT_STATUSES, PROJECT_TYPES } from "../../../shared/api-types.js";
import { parseGitHubRemote, isSafeSegment } from "../../../shared/github-remote.js";
import { getDb, nowIso, withTransaction } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { deriveLocalBindingHealth } from "./BindingHealthService.js";
import {
  persistActivityEventsDirect,
  type DerivedEvent,
} from "./ActivityService.js";
import { refreshTrackedBinding } from "./GitHubPickerService.js";
import { fetchGitHubRepoMetadata } from "./GitHubService.js";

/**
 * Project-centric domain layer (V1.1).
 *
 * A Project owns manual metadata and has zero-or-one GitHub binding plus
 * zero-or-more local bindings. `sourceState` is derived, never stored.
 */

export type ProjectRow = {
  id: number;
  name: string;
  project_status: ProjectStatus | null;
  project_type: ProjectType | null;
  project_note: string | null;
  include_in_portfolio: number;
  portfolio_order: number | null;
  created_at: string;
  updated_at: string;
};

type GhBindingRow = {
  id: number;
  project_id: number | null;
  owner: string;
  name: string;
  full_name: string;
  visibility: string | null;
  default_branch: string | null;
  html_url: string | null;
  last_pushed_at: string | null;
  tracked_at: string | null;
};

export function getProjectRow(id: number): ProjectRow {
  const row = getDb()
    .prepare(
      `SELECT id, name, project_status, project_type, project_note,
              include_in_portfolio, portfolio_order, created_at, updated_at
       FROM projects WHERE id = ?`,
    )
    .get(id) as ProjectRow | undefined;
  if (!row) {
    throw new AppError(ErrorCodes.REPOSITORY_NOT_FOUND, "Project was not found.", 404);
  }
  return row;
}

/**
 * V1.2 M1 — repair the display primary after any local-binding write:
 * exactly one is_primary=1 per project with local bindings, anchored on
 * MIN(id) when no explicit primary survives. Defensive backstop for the
 * transactional paths above; a no-op when the invariant already holds.
 * Called inside the caller's transaction.
 */
export function ensureSinglePrimary(projectId: number): void {
  const db = getDb();
  const primary = db
    .prepare(
      `SELECT id FROM local_repositories
       WHERE project_id = ? AND is_primary = 1
       ORDER BY id ASC LIMIT 1`,
    )
    .get(projectId) as { id: number } | undefined;
  if (primary != null) return;
  const anchor = db
    .prepare(
      `SELECT id FROM local_repositories WHERE project_id = ? ORDER BY id ASC LIMIT 1`,
    )
    .get(projectId) as { id: number } | undefined;
  if (anchor == null) return;
  db.prepare("UPDATE local_repositories SET is_primary = 1 WHERE id = ?").run(anchor.id);
}

/**
 * V1.2 M1 — display-primary switch (POST /api/repositories/:id/primary).
 * Pure preference flip inside one transaction: unset the project's current
 * primary, set the selected binding. NO Git call, NO filesystem access, and
 * NO activity event (a UI/source preference is not development activity).
 * Returns only enough state for UI/cache reconciliation; the fingerprint
 * anchor (MIN(id), owner decision D1) is internal persistence identity and
 * is deliberately NOT part of the API surface.
 */
export function setPrimaryLocalBinding(id: number): SetPrimaryLocalBindingResponse {
  return withTransaction(() => {
    const db = getDb();
    const binding = db
      .prepare(
        `SELECT id, project_id FROM local_repositories WHERE id = ?`,
      )
      .get(id) as { id: number; project_id: number | null } | undefined;
    if (binding == null) {
      throw new AppError(ErrorCodes.REPOSITORY_NOT_FOUND, "Repository was not found.", 404);
    }
    if (binding.project_id == null) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        "That local repository does not belong to a Project.",
        400,
      );
    }
    const alreadyPrimary =
      (
        db
          .prepare(
            "SELECT is_primary FROM local_repositories WHERE id = ?",
          )
          .get(id) as { is_primary: number }
      ).is_primary === 1;
    if (!alreadyPrimary) {
      db.prepare(
        "UPDATE local_repositories SET is_primary = 0 WHERE project_id = ? AND is_primary = 1",
      ).run(binding.project_id);
      db.prepare(
        "UPDATE local_repositories SET is_primary = 1 WHERE id = ?",
      ).run(id);
    }
    return {
      ok: true,
      projectId: binding.project_id,
      primaryRepositoryId: id,
    };
  });
}

export function githubBindingForProject(projectId: number): GhBindingRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, project_id, owner, name, full_name, visibility, default_branch,
                html_url, last_pushed_at, tracked_at
         FROM github_repositories
         WHERE project_id = ?
         LIMIT 1`,
      )
      .get(projectId) as GhBindingRow | undefined) ?? null
  );
}

export function localBindingCount(projectId: number): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ?")
      .get(projectId) as { n: number }
  ).n;
}

/** Latest meaningful activity time across both event origins. */
function lastMeaningfulAt(projectId: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(occurred_at) AS at FROM activity_events
       WHERE project_id = ?
         AND event_type IN ('commit_observed','github_commit_observed',
                            'working_tree_dirty','working_tree_clean',
                            'branch_changed','ahead_changed','behind_changed')`,
    )
    .get(projectId) as { at: string | null };
  return row.at ?? null;
}

/**
 * V1.2 M1 server-authoritative DISPLAY-PRIMARY resolver.
 *
 * 1. explicit is_primary=1 binding (the user-selected primary);
 * 2. defensive fallback to MIN(id) — repairs legacy/hand-mangled rows that
 *    lack an explicit primary so user-visible state never disappears.
 *
 * This is the ONLY concept the UI sees. It is deliberately distinct from
 * the fingerprint anchor below (owner decision D1): switching the display
 * primary must never re-key historical activity.
 */
export function primaryLocalBindingId(projectId: number): number | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM local_repositories
       WHERE project_id = ?
       ORDER BY is_primary DESC, id ASC
       LIMIT 1`,
    )
    .get(projectId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * V1.2 M1 FINGERPRINT ANCHOR (owner decision D1, LOCKED).
 *
 * Deterministic MIN(local_repository.id) per project — permanently stable
 * and completely INDEPENDENT of the display primary. All project-scoped
 * activity fingerprints resolve their scope segment through this helper;
 * changing which binding the user displays as primary must never produce
 * a different fingerprint for the same logical event.
 */
export function fingerprintAnchorLocalBindingId(projectId: number): number | null {
  const row = getDb()
    .prepare(
      "SELECT MIN(id) AS id FROM local_repositories WHERE project_id = ?",
    )
    .get(projectId) as { id: number | null };
  return row.id ?? null;
}

export function deriveSourceState(projectId: number): SourceState {
  const gh = githubBindingForProject(projectId);
  const locals = localBindingCount(projectId);
  if (locals > 0 && gh != null) return "LOCAL + GITHUB";
  if (locals > 0) return "LOCAL ONLY";
  // Zero-binding Projects must never masquerade as GitHub-backed. The
  // resting NO SOURCE state is itself an invariant violation; it exists
  // only transiently mid-transaction or on pre-repair ghost rows (see
  // migration 007), and the lifecycle closes it automatically.
  return gh != null ? "GITHUB ONLY" : "NO SOURCE";
}

/**
 * Shared final-binding removal lifecycle (Q1 invariant, applied uniformly
 * to BOTH source kinds). Call inside a transaction AFTER the binding has
 * been detached/removed.
 *
 * - another binding remains -> project survives, nothing to do;
 * - no bindings + empty project -> auto-delete (cascade removes history);
 * - no bindings + meaningful state -> refuses with PROJECT_HAS_NO_SOURCES
 *   so the client can ask keep-or-delete before destroying the Project.
 *   confirmDeleteProject=true is that explicit owner decision and bypasses
 *   the refusal (accepted GitHub-untrack semantics).
 *
 * Never touches the filesystem or GitHub: bindings are database rows only.
 */
export function finalizeProjectAfterFinalBindingRemoval(
  projectId: number,
  options: { confirmDeleteProject?: boolean } = {},
): { projectDeleted: boolean } {
  if (localBindingCount(projectId) > 0 || githubBindingForProject(projectId) != null) {
    return { projectDeleted: false };
  }
  if (!projectHasMeaningfulState(projectId) || options.confirmDeleteProject === true) {
    deleteProjectCascade(projectId);
    return { projectDeleted: true };
  }
  throw new AppError(
    ErrorCodes.PROJECT_HAS_NO_SOURCES,
    "This project has notes/status/portfolio state/history. Confirm deletion.",
    409,
  );
}

export function githubMetadataForProject(projectId: number): GitHubMetadataDto | null {
  const binding = githubBindingForProject(projectId);
  if (!binding) return null;
  return {
    owner: binding.owner,
    name: binding.name,
    fullName: binding.full_name,
    visibility: binding.visibility,
    defaultBranch: binding.default_branch,
    htmlUrl: binding.html_url ?? `https://github.com/${binding.owner}/${binding.name}`,
    lastPushedAt: binding.last_pushed_at,
  };
}

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

export function listProjects(filter?: { state?: string; query?: string }): ProjectListItemDto[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, project_status, project_type, project_note,
              include_in_portfolio, portfolio_order, created_at, updated_at
       FROM projects ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all() as ProjectRow[];

  const items: ProjectListItemDto[] = rows.map((row) => {
    const state = deriveSourceState(row.id);
    const gh = githubBindingForProject(row.id);
    // V1.2 M1: server-authoritative display primary (explicit is_primary,
    // MIN(id) fallback) — never a name- or id-ordered guess.
    const primaryLocal =
      (
        getDb()
          .prepare(
            `SELECT local_path FROM local_repositories
             WHERE project_id = ?
             ORDER BY is_primary DESC, id ASC
             LIMIT 1`,
          )
          .get(row.id) as { local_path: string } | undefined
      )?.local_path ?? null;
    return {
      id: row.id,
      name: row.name,
      sourceState: state,
      projectStatus: row.project_status,
      projectType: row.project_type,
      includeInPortfolio: row.include_in_portfolio === 1,
      portfolioOrder: row.portfolio_order,
      localPath: primaryLocal,
      githubFullName: gh?.full_name ?? null,
      githubHtmlUrl:
        gh?.html_url ??
        (gh ? `https://github.com/${gh.owner}/${gh.name}` : null),
      lastMeaningfulAt: lastMeaningfulAt(row.id),
    };
  });

  const query = filter?.query?.trim().toLowerCase();
  return items.filter((item) => {
    if (filter?.state && filter.state !== "ALL" && item.sourceState !== filter.state) {
      return false;
    }
    if (query) {
      const haystack = `${item.name} ${item.localPath ?? ""} ${item.githubFullName ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** Source-aware project detail. Unavailable local fields are null by design. */
export async function getProjectDetail(id: number): Promise<{
  project: ProjectListItemDto & {
    projectNote: string | null;
    snapshot: SnapshotDto | null;
    localBindings: ProjectLocalBindingDto[];
    githubMetadata: GitHubMetadataDto | null;
    commits: Array<{ sha: string; shortSha: string; subject: string; authorName: string | null; committedAt: string | null; source: "local" | "github" }>;
  };
}> {
  const row = getProjectRow(id);
  const state = deriveSourceState(id);
  const gh = githubBindingForProject(id);
  const db = getDb();

  // V1.2 M2 read model: EVERY local binding of the Project, display primary
  // first. The ORDER BY (is_primary DESC, id ASC) IS the M1 effective-primary
  // rule: explicit primary wins; with no explicit primary it degrades to
  // MIN(id). Building this DTO spawns NO Git process — SQLite reads plus one
  // cheap filesystem existence check per binding (inside
  // deriveLocalBindingHealth).
  const bindingRows = db
    .prepare(
      `SELECT id, is_primary, name, local_path, canonical_path, discovery_type,
              source_id, last_scanned_at, last_health_state, last_health_checked_at
       FROM local_repositories
       WHERE project_id = ?
       ORDER BY is_primary DESC, id ASC`,
    )
    .all(id) as Array<{
    id: number;
    is_primary: number;
    name: string;
    local_path: string;
    canonical_path: string;
    discovery_type: "scanned" | "manual";
    source_id: number | null;
    last_scanned_at: string | null;
    last_health_state: string | null;
    last_health_checked_at: string | null;
  }>;

  // Each binding carries its OWN latest snapshot. The pre-M2 Project Detail
  // contract is authoritative here: captured_at DESC with id ONLY as the
  // tie-breaker — a restored/out-of-order dataset can hold a higher snapshot
  // id with an OLDER captured_at, so MAX(id) is NOT the same rule. Batched
  // with ROW_NUMBER instead of the per-binding LIMIT 1 the old code ran.
  const snapshotByBinding = new Map<number, SnapshotDto>();
  if (bindingRows.length > 0) {
    const ids = bindingRows.map((binding) => binding.id);
    const snaps = db
      .prepare(
        `SELECT rid, branch, head_commit_sha, is_dirty, modified_count, staged_count,
                untracked_count, upstream_ref, ahead_count, behind_count, captured_at
         FROM (
           SELECT s.local_repository_id AS rid, s.branch, s.head_commit_sha, s.is_dirty,
                  s.modified_count, s.staged_count, s.untracked_count, s.upstream_ref,
                  s.ahead_count, s.behind_count, s.captured_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.local_repository_id
                    ORDER BY s.captured_at DESC, s.id DESC
                  ) AS rn
           FROM repository_snapshots s
           WHERE s.local_repository_id IN (${ids.map(() => "?").join(",")})
         ) ranked
         WHERE rn = 1`,
      )
      .all(...ids) as Array<{
      rid: number;
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
    }>;
    for (const snap of snaps) {
      snapshotByBinding.set(snap.rid, {
        branch: snap.branch,
        headCommitSha: snap.head_commit_sha,
        isDirty: snap.is_dirty === 1,
        modifiedCount: snap.modified_count,
        stagedCount: snap.staged_count,
        untrackedCount: snap.untracked_count,
        upstreamRef: snap.upstream_ref,
        aheadCount: snap.ahead_count,
        behindCount: snap.behind_count,
        capturedAt: snap.captured_at,
      });
    }
  }

  // rows[0] is the effective display primary by construction of the ORDER BY.
  const effectivePrimaryId = bindingRows[0]?.id ?? null;
  const localBindings: ProjectLocalBindingDto[] = bindingRows.map((binding) => ({
    id: binding.id,
    isPrimary: binding.id === effectivePrimaryId,
    name: binding.name,
    localPath: binding.local_path,
    canonicalPath: binding.canonical_path,
    discoveryType: binding.discovery_type,
    sourceId: binding.source_id,
    lastScannedAt: binding.last_scanned_at,
    snapshot: snapshotByBinding.get(binding.id) ?? null,
    health: deriveLocalBindingHealth(binding),
  }));

  // M2-B: Project-level legacy fields keep describing ONLY the display
  // primary. A non-primary dirty worktree or branch must never leak into
  // these top-level values.
  const snapshot =
    effectivePrimaryId != null
      ? snapshotByBinding.get(effectivePrimaryId) ?? null
      : null;

  // M2-C: local commit history reads across ALL local bindings of the
  // Project, deduplicated at READ TIME on Project + lower(commit SHA). The
  // same SHA observed in two local copies appears once; distinct SHAs from
  // divergent copies both appear. Dedup happens BEFORE the 20-row display
  // limit. The representative row is deterministic — effective
  // display-primary observation first, then lowest binding id, then commit
  // row id — never a repository name/order heuristic. Raw commits rows are
  // never deleted or rewritten here.
  let localCommits: Array<{ sha: string; shortSha: string; subject: string; authorName: string | null; committedAt: string | null; source: "local" | "github" }> = [];
  if (bindingRows.length > 0) {
    const unionRows = db
      .prepare(
        `SELECT sha, subject, authorName, committedAt FROM (
           SELECT c.commit_sha AS sha,
                  lower(c.commit_sha) AS lsha,
                  c.subject AS subject,
                  c.author_name AS authorName,
                  c.committed_at AS committedAt,
                  c.id AS rowId,
                  ROW_NUMBER() OVER (
                    PARTITION BY lower(c.commit_sha)
                    ORDER BY lr.is_primary DESC, lr.id ASC, c.id ASC
                  ) AS rn
           FROM commits c
           JOIN local_repositories lr ON lr.id = c.local_repository_id
           WHERE lr.project_id = ?
         ) ranked
         WHERE rn = 1
         ORDER BY committedAt DESC, rowId DESC, lsha ASC
         LIMIT 20`,
      )
      .all(id) as Array<{
      sha: string;
      subject: string;
      authorName: string | null;
      committedAt: string | null;
    }>;
    localCommits = unionRows.map((row2) => ({
      sha: row2.sha,
      shortSha: row2.sha.slice(0, 7),
      subject: row2.subject,
      authorName: row2.authorName,
      committedAt: row2.committedAt,
      source: "local" as const,
    }));
  }

  // GitHub-only commits fill the history for GITHUB ONLY projects.
  let githubCommits: typeof localCommits = [];
  if (state === "GITHUB ONLY" && gh) {
    const gcs = db
      .prepare(
        `SELECT commit_sha AS sha, subject, author_name AS authorName, committed_at AS committedAt
         FROM github_commits WHERE github_repository_id = ?
         ORDER BY committed_at DESC, id DESC LIMIT 20`,
      )
      .all(gh.id) as Array<{ sha: string; subject: string | null; authorName: string | null; committedAt: string | null }>;
    githubCommits = gcs.map((row2) => ({
      sha: row2.sha,
      shortSha: row2.sha.slice(0, 7),
      subject: row2.subject ?? "(no subject)",
      authorName: row2.authorName,
      committedAt: row2.committedAt,
      source: "github" as const,
    }));
  }

  return {
    project: {
      id: row.id,
      name: row.name,
      sourceState: state,
      projectStatus: row.project_status,
      projectType: row.project_type,
      projectNote: row.project_note,
      includeInPortfolio: row.include_in_portfolio === 1,
      portfolioOrder: row.portfolio_order,
      localPath:
        effectivePrimaryId != null
          ? bindingRows.find((binding) => binding.id === effectivePrimaryId)?.local_path ?? null
          : null,
      githubFullName: gh?.full_name ?? null,
      githubHtmlUrl: gh?.html_url ?? (gh ? `https://github.com/${gh.owner}/${gh.name}` : null),
      lastMeaningfulAt: lastMeaningfulAt(row.id),
      snapshot,
      localBindings,
      githubMetadata: githubMetadataForProject(id),
      commits: [...localCommits, ...githubCommits],
    },
  };
}

/**
 * Find a local binding whose parsed GitHub remote identity matches
 * owner/name. Identity comparison is case-insensitive.
 */
export function findLocalMatch(
  fullName: string,
): { projectId: number; repoId: number } | null {
  const [owner, name] = fullName.split("/");
  if (!owner || !name || !isSafeSegment(owner) || !isSafeSegment(name)) return null;
  const rows = getDb()
    .prepare(
      `SELECT lr.project_id AS projectId, lr.id AS repoId, r.url
       FROM local_repositories lr
       JOIN git_remotes r ON r.local_repository_id = lr.id
       WHERE lr.project_id IS NOT NULL`,
    )
    .all() as Array<{ projectId: number; repoId: number; url: string }>;
  for (const row of rows) {
    const parsed = parseGitHubRemote(row.url);
    if (
      parsed &&
      parsed.owner.toLowerCase() === owner.toLowerCase() &&
      parsed.repository.toLowerCase() === name.toLowerCase()
    ) {
      return { projectId: row.projectId, repoId: row.repoId };
    }
  }
  return null;
}

/**
 * Track a GitHub repository (never clones). Links to the existing project
 * when a local binding's remote identity matches; otherwise creates a new
 * GITHUB ONLY project. Offline-safe: metadata fetch failure still tracks.
 */
export async function trackGitHubRepository(input: {
  fullName: unknown;
}): Promise<{ githubRepositoryId: number; projectId: number; state: SourceState }> {
  if (typeof input.fullName !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(input.fullName)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "fullName must be owner/name.");
  }
  const [owner, name] = input.fullName.split("/");
  if (!isSafeSegment(owner) || !isSafeSegment(name)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Invalid repository identity.");
  }

  const db = getDb();
  const now = nowIso();

  let metadata: Awaited<ReturnType<typeof fetchGitHubRepoMetadata>> = null;
  try {
    metadata = await fetchGitHubRepoMetadata(owner, name);
  } catch {
    metadata = null; // offline tracking allowed; cache fields stay stale/null
  }

  const resolvedOwner = metadata?.owner ?? owner;
  const resolvedName = metadata?.name ?? name;
  const fullName = `${resolvedOwner}/${resolvedName}`;

  return withTransaction(async () => {
    // Identity lookup: normalized columns first, then case-insensitive raw
    // columns so PRE-V1.1 enrichment rows (owner_norm/name_norm IS NULL)
    // are found instead of colliding with UNIQUE(owner, name) on insert.
    let existing = db
      .prepare(
        "SELECT id, project_id FROM github_repositories WHERE owner_norm = lower(?) AND name_norm = lower(?)",
      )
      .get(resolvedOwner, resolvedName) as
      | { id: number; project_id: number | null }
      | undefined;
    if (existing == null) {
      existing = db
        .prepare(
          "SELECT id, project_id FROM github_repositories WHERE lower(owner) = lower(?) AND lower(name) = lower(?)",
        )
        .get(resolvedOwner, resolvedName) as
        | { id: number; project_id: number | null }
        | undefined;
    }

    // Link-first: an existing local binding's remote identity wins so the
    // project becomes LOCAL + GITHUB without duplication.
    const match = findLocalMatch(fullName);

    if (existing?.project_id != null) {
      if (match != null && existing.project_id !== match.projectId) {
        // Case D: the row belongs to a different curated project — never
        // silently reassign; preserve both projects.
        throw new AppError(
          ErrorCodes.GITHUB_REPO_CONFLICT,
          "That GitHub repository is already tracked under a different project.",
          409,
        );
      }
      // Case C: already linked (idempotent per approved API semantics).
      throw new AppError(
        ErrorCodes.ALREADY_TRACKED,
        "That repository is already tracked.",
        409,
      );
    }

    const projectId =
      match?.projectId ??
      Number(
        db
          .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
          .run(resolvedName, now, now).lastInsertRowid,
      );

    let ghId: number = existing?.id ?? 0;
    if (existing) {
      // Case B: ADOPT the existing cache/promotion candidate row. Guarded
      // UPDATE only — the row id, its foreign-key history, and every cached
      // field survive; COALESCE keeps old metadata unless fresh arrives.
      db.prepare(
        `UPDATE github_repositories SET
           project_id = ?,
           tracked_at = ?,
           last_refreshed_at = COALESCE(?, last_refreshed_at),
           full_name = ?,
           owner = ?,
           name = ?,
           owner_norm = lower(?),
           name_norm = lower(?),
           html_url = COALESCE(?, html_url),
           visibility = COALESCE(?, visibility),
           default_branch = COALESCE(?, default_branch),
           last_pushed_at = COALESCE(?, last_pushed_at)
         WHERE id = ?`,
      ).run(
        projectId,
        now,
        now,
        fullName,
        resolvedOwner,
        resolvedName,
        resolvedOwner,
        resolvedName,
        metadata?.htmlUrl ?? null,
        metadata?.visibility ?? null,
        metadata?.defaultBranch ?? null,
        metadata?.lastPushedAt ?? null,
        existing.id,
      );
    } else {
      // Case A: brand-new identity.
      const insert = db
        .prepare(
          `INSERT INTO github_repositories
            (owner, name, full_name, owner_norm, name_norm, visibility, default_branch,
             html_url, last_pushed_at, last_refreshed_at, project_id, tracked_at)
           VALUES (?, ?, ?, lower(?), lower(?), ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resolvedOwner,
          resolvedName,
          fullName,
          resolvedOwner,
          resolvedName,
          metadata?.visibility ?? null,
          metadata?.defaultBranch ?? null,
          metadata?.htmlUrl ?? `https://github.com/${resolvedOwner}/${resolvedName}`,
          metadata?.lastPushedAt ?? null,
          now,
          projectId,
          now,
        );
      ghId = Number(insert.lastInsertRowid);
    }

    persistActivityEventsDirect(projectId, [
      {
        eventType: "github_repo_tracked",
        summary: `GitHub repository tracked: ${fullName}`,
        occurredAt: now,
        fingerprint: projectScopedFingerprint(projectId, `github_repo_tracked:${fullName.toLowerCase()}`),
        metadata: { projectId, fullName },
      },
    ]);

    // Optional bounded initial refresh (owner-approved behavior): tracking
    // has already succeeded transactionally; a GitHub failure here must not
    // fail the request — the user can Refresh manually later.
    let initialRefresh: "ok" | "failed" | "skipped" = "skipped";
    try {
      const result = await refreshTrackedBinding(ghId);
      initialRefresh = result.ok ? "ok" : "failed";
    } catch {
      initialRefresh = "failed";
    }

    return { githubRepositoryId: ghId, projectId, state: deriveSourceState(projectId), initialRefresh };
  });
}

/**
 * Disconnect/untrack a GitHub binding (Q1 lifecycle, LOCKED).
 */
export async function untrackGitHubRepository(input: {
  githubRepositoryId: number;
  confirmDeleteProject: boolean;
}): Promise<{ ok: true; projectDeleted: boolean }> {
  const db = getDb();
  const binding = db
    .prepare("SELECT id, project_id, full_name FROM github_repositories WHERE id = ?")
    .get(input.githubRepositoryId) as
    | { id: number; project_id: number | null; full_name: string }
    | undefined;
  if (!binding || binding.project_id == null) {
    throw new AppError(
      ErrorCodes.GITHUB_REPO_NOT_FOUND,
      "Tracked GitHub repository was not found.",
      404,
    );
  }
  const projectId = binding.project_id;

  return withTransaction(async () => {
    // Detach the binding; cached data is retained but excluded from live
    // views automatically (queries join through project_id).
    db.prepare(
      "UPDATE github_repositories SET project_id = NULL, tracked_at = NULL WHERE id = ?",
    ).run(binding.id);

    if (localBindingCount(projectId) > 0) {
      persistActivityEventsDirect(projectId, [
        {
          eventType: "github_repo_untracked",
          summary: `GitHub repository disconnected: ${binding.full_name}`,
          occurredAt: nowIso(),
          fingerprint: projectScopedFingerprint(
            projectId,
            `github_repo_untracked:${Date.now()}`,
          ),
          metadata: { projectId, fullName: binding.full_name },
        },
      ]);
      // LOCAL + GITHUB -> LOCAL ONLY; metadata lives on the project.
      return { ok: true as const, projectDeleted: false };
    }

    // GITHUB ONLY -> project loses its only binding. Same Q1 lifecycle as
    // local removal: empty auto-deletes, meaningful refuses without an
    // explicit confirmation (which bypasses the refusal, owner decided).
    return {
      ok: true as const,
      projectDeleted: finalizeProjectAfterFinalBindingRemoval(projectId, {
        confirmDeleteProject: input.confirmDeleteProject,
      }).projectDeleted,
    };
  });
}

/**
 * Q1 emptiness proof: auto-delete only when provably no meaningful state.
 *
 * Meaningful = user-curated metadata, real history (local or GitHub
 * commits), or a non-routine activity event. Routine bookkeeping events —
 * repository_discovered plus tracked/untracked lifecycle markers — do NOT
 * make an otherwise empty Project immortal: they are system observations,
 * not owner-authored content.
 */
export function projectHasMeaningfulState(projectId: number): boolean {
  const db = getDb();
  const project = db
    .prepare(
      `SELECT project_status, project_type, project_note, include_in_portfolio
       FROM projects WHERE id = ?`,
    )
    .get(projectId) as
    | {
        project_status: ProjectStatus | null;
        project_type: ProjectType | null;
        project_note: string | null;
        include_in_portfolio: number;
      }
    | undefined;
  if (!project) return false;
  if (
    project.project_status != null ||
    project.project_type != null ||
    project.project_note != null ||
    project.include_in_portfolio === 1
  ) {
    return true;
  }
  const commits =
    (
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM commits c
              JOIN local_repositories lr ON lr.id = c.local_repository_id
              WHERE lr.project_id = ?) +
             (SELECT COUNT(*) FROM github_commits gc WHERE gc.project_id = ?)
             AS n`,
        )
        .get(projectId, projectId) as { n: number }
    ).n > 0;
  // Non-meaningful event types (owner decision): routine system bookkeeping.
  // github_binding_updated is included defensively so a future emitter can
  // never accidentally freeze Projects against their lifecycle.
  const events =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM activity_events WHERE project_id = ?
           AND event_type NOT IN ('repository_discovered','github_repo_tracked',
                                  'github_repo_untracked','github_binding_updated')`,
        )
        .get(projectId) as { n: number }
    ).n > 0;
  return commits || events;
}

function deleteProjectCascade(projectId: number): void {
  const db = getDb();
  db.prepare("DELETE FROM github_commits WHERE project_id = ?").run(projectId);
  db.prepare(
    "UPDATE github_repositories SET project_id = NULL, tracked_at = NULL WHERE project_id = ?",
  ).run(projectId);
  db.prepare("DELETE FROM activity_events WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM local_repositories WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
}

/**
 * Project-scoped fingerprint. The second segment mirrors the legacy
 * repo-id namespace: the FINGERPRINT ANCHOR binding (deterministic
 * MIN(id), owner decision D1) when one exists — never the mutable
 * display primary, so switching the primary cannot re-key history —
 * else the project itself.
 */
function projectScopedFingerprint(projectId: number, rest: string): string {
  const scope = fingerprintAnchorLocalBindingId(projectId) ?? projectId;
  return `p${projectId}:${scope}:${rest}`;
}

// ---------------------------------------------------------------------------
// Metadata ownership lives on Project.
// ---------------------------------------------------------------------------

const METADATA_ERROR =
  "Metadata is invalid. Provide valid projectStatus/projectType values, a note of at most 500 characters, and a boolean portfolio flag.";

function metadataError(): AppError {
  return new AppError(ErrorCodes.INVALID_METADATA, METADATA_ERROR);
}

export async function updateProjectMetadata(
  id: number,
  input: unknown,
): Promise<void> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw metadataError();
  }
  const body = input as Record<string, unknown>;
  const allowed = [
    "projectStatus",
    "projectType",
    "projectNote",
    "includeInPortfolio",
    "portfolioOrder",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw metadataError();
  }

  let nextStatus: ProjectStatus | null | undefined;
  if (body.projectStatus !== undefined) {
    if (body.projectStatus === null) nextStatus = null;
    else if (
      typeof body.projectStatus === "string" &&
      (PROJECT_STATUSES as readonly string[]).includes(body.projectStatus)
    ) {
      nextStatus = body.projectStatus as ProjectStatus;
    } else throw metadataError();
  }
  let nextType: ProjectType | null | undefined;
  if (body.projectType !== undefined) {
    if (body.projectType === null) nextType = null;
    else if (
      typeof body.projectType === "string" &&
      (PROJECT_TYPES as readonly string[]).includes(body.projectType)
    ) {
      nextType = body.projectType as ProjectType;
    } else throw metadataError();
  }
  let nextNote: string | null | undefined;
  if (body.projectNote !== undefined) {
    if (body.projectNote === null) nextNote = null;
    else if (typeof body.projectNote === "string") {
      const trimmed = body.projectNote.trim();
      if (trimmed.length > 500) throw metadataError();
      nextNote = trimmed.length > 0 ? trimmed : null;
    } else throw metadataError();
  }
  let nextInclude: boolean | undefined;
  if (body.includeInPortfolio !== undefined) {
    if (typeof body.includeInPortfolio === "boolean") nextInclude = body.includeInPortfolio;
    else throw metadataError();
  }
  let nextOrder: number | null | undefined;
  if (body.portfolioOrder !== undefined) {
    if (body.portfolioOrder === null) nextOrder = null;
    else if (typeof body.portfolioOrder === "number" && Number.isInteger(body.portfolioOrder)) {
      nextOrder = body.portfolioOrder;
    } else throw metadataError();
  }

  const project = getProjectRow(id);
  const observedAt = nowIso();

  if (nextStatus !== undefined && nextStatus !== project.project_status) {
    persistActivityEventsDirect(id, [
      {
        eventType: "project_status_changed",
        summary: `Project status changed from ${project.project_status ?? "—"} to ${nextStatus ?? "—"}`,
        occurredAt: observedAt,
        fingerprint: projectScopedFingerprint(
          id,
          `project_status_changed:${project.project_status ?? "none"}->${nextStatus ?? "none"}`,
        ),
        metadata: { from: project.project_status, to: nextStatus },
      },
    ]);
  }
  if (nextNote !== undefined && nextNote !== project.project_note) {
    persistActivityEventsDirect(id, [
      {
        eventType: "project_note_updated",
        summary: `Project note updated${nextNote ? `: ${nextNote}` : ""}`,
        occurredAt: observedAt,
        fingerprint: projectScopedFingerprint(
          id,
          `project_note_updated:${hashNote(nextNote ?? "")}`,
        ),
        metadata: { length: (nextNote ?? "").length },
      },
    ]);
  }

  withTransaction(() => {
    getDb()
      .prepare(
        `UPDATE projects SET
           project_status = CASE WHEN ?1 THEN ?2 ELSE project_status END,
           project_type   = CASE WHEN ?3 THEN ?4 ELSE project_type END,
           project_note   = CASE WHEN ?5 THEN ?6 ELSE project_note END,
           include_in_portfolio = CASE WHEN ?7 THEN ?8 ELSE include_in_portfolio END,
           portfolio_order = CASE WHEN ?9 THEN ?10 ELSE portfolio_order END,
           updated_at = ?11
         WHERE id = ?12`,
      )
      .run(
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
        nowIso(),
        id,
      );
  });
}

import { createHash } from "node:crypto";

function hashNote(note: string): string {
  return createHash("sha256").update(note).digest("hex").slice(0, 12);
}