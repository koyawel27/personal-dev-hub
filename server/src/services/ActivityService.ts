import type { ActivityEventDto, EventType } from "../../../shared/api-types.js";
import { getDb } from "../db/client.js";
import type { GitInspection } from "./GitService.js";

export type PreviousSnapshot = {
  branch: string | null;
  headCommitSha: string | null;
  isDirty: boolean;
  upstreamRef: string | null;
  aheadCount: number | null;
  behindCount: number | null;
};

export type DerivedEvent = {
  eventType: EventType;
  summary: string;
  occurredAt: string;
  fingerprint: string;
  metadata: Record<string, unknown>;
};

export function deriveActivityEvents(input: {
  repositoryId: number;
  isNewRepository: boolean;
  previous: PreviousSnapshot | null;
  inspection: GitInspection;
  knownCommitShas: Set<string>;
  observedAt: string;
}): DerivedEvent[] {
  const {
    repositoryId,
    isNewRepository,
    previous,
    inspection,
    knownCommitShas,
    observedAt,
  } = input;
  const events: DerivedEvent[] = [];

  if (isNewRepository) {
    events.push({
      eventType: "repository_discovered",
      summary: "Repository discovered",
      occurredAt: observedAt,
      fingerprint: `${repositoryId}:repository_discovered`,
      metadata: { path: true },
    });
  }

  for (const commit of inspection.recentCommits) {
    if (knownCommitShas.has(commit.sha)) continue;
    const occurredAt = commit.committedAt || observedAt;
    events.push({
      eventType: "commit_observed",
      summary: commit.subject,
      occurredAt,
      fingerprint: `${repositoryId}:commit:${commit.sha}`,
      metadata: {
        sha: commit.sha,
        authorName: commit.authorName,
      },
    });
  }

  if (previous) {
    const wasDirty = previous.isDirty;
    const isDirty = inspection.workingTree.isDirty;
    if (!wasDirty && isDirty) {
      events.push({
        eventType: "working_tree_dirty",
        summary: "Working tree became uncommitted",
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:working_tree_dirty:${observedAt}`,
        metadata: {
          modifiedCount: inspection.workingTree.modifiedCount,
          stagedCount: inspection.workingTree.stagedCount,
          untrackedCount: inspection.workingTree.untrackedCount,
        },
      });
    } else if (wasDirty && !isDirty) {
      events.push({
        eventType: "working_tree_clean",
        summary: "Working tree became clean",
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:working_tree_clean:${observedAt}`,
        metadata: {},
      });
    }

    if (previous.branch && inspection.branch && previous.branch !== inspection.branch) {
      events.push({
        eventType: "branch_changed",
        summary: `Branch changed from ${previous.branch} to ${inspection.branch}`,
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:branch_changed:${previous.branch}->${inspection.branch}:${observedAt}`,
        metadata: { from: previous.branch, to: inspection.branch },
      });
    }

    const prevAhead = previous.aheadCount;
    const nextAhead = inspection.aheadCount;
    if (prevAhead !== nextAhead && (prevAhead != null || nextAhead != null)) {
      events.push({
        eventType: "ahead_changed",
        summary:
          nextAhead == null
            ? "Ahead count is no longer known"
            : `Ahead count is now ${nextAhead}`,
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:ahead_changed:${prevAhead ?? "none"}->${nextAhead ?? "none"}:${observedAt}`,
        metadata: { from: prevAhead, to: nextAhead },
      });
    }

    const prevBehind = previous.behindCount;
    const nextBehind = inspection.behindCount;
    if (prevBehind !== nextBehind && (prevBehind != null || nextBehind != null)) {
      events.push({
        eventType: "behind_changed",
        summary:
          nextBehind == null
            ? "Behind count is no longer known"
            : `Behind count is now ${nextBehind}`,
        occurredAt: observedAt,
        fingerprint: `${repositoryId}:behind_changed:${prevBehind ?? "none"}->${nextBehind ?? "none"}:${observedAt}`,
        metadata: { from: prevBehind, to: nextBehind },
      });
    }
  }

  return events;
}

export function persistActivityEvents(
  repositoryId: number,
  events: DerivedEvent[],
): void {
  const row = getDb()
    .prepare("SELECT project_id FROM local_repositories WHERE id = ?")
    .get(repositoryId) as { project_id: number | null } | undefined;
  if (!row || row.project_id == null) {
    throw new Error(`Repository ${repositoryId} has no project mapping.`);
  }
  persistActivityEventsDirect(row.project_id, events, repositoryId);
}

/**
 * Project-aware activity feed (V1.1). Events belong to projects; the
 * project name resolves through the owning project (falling back to the
 * binding name for pre-004 rows), and GitHub-origin events appear alongside
 * local ones. Optional filters: projectId, repositoryId, date range.
 *
 * Commit dedup (owner decision): one logical commit observed by BOTH the
 * local scan and a tracked GitHub refresh is ONE meaningful activity row,
 * not two. Raw observations are preserved on disk; collapse happens here at
 * read time using the canonical key PROJECT + commit SHA (metadata_json.sha)
 * — the same identity rule Combined Contributions already applies. Subjects,
 * authors, and timestamps are never used as identity. Non-commit events
 * (repo tracked/untracked, discoveries, metadata changes, tree/branch
 * transitions) are distinct history and always pass through untouched.
 */
export function listActivity(filters: {
  projectId?: number;
  repositoryId?: number;
  from?: string;
  to?: string;
}): ActivityEventDto[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filters.projectId != null) {
    clauses.push("e.project_id = ?");
    params.push(filters.projectId);
  }
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
         e.project_id,
         COALESCE(p.name, lr.name, '(unknown)') AS project_name,
         e.event_type,
         e.summary,
         e.occurred_at,
         e.source,
         lower(json_extract(e.metadata_json, '$.sha')) AS sha
       FROM activity_events e
       LEFT JOIN local_repositories lr ON lr.id = e.local_repository_id
       LEFT JOIN projects p ON p.id = COALESCE(e.project_id, lr.project_id)
       ${where}
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT 400`,
    )
    .all(...params) as Array<{
    id: number;
    local_repository_id: number | null;
    project_id: number | null;
    project_name: string | null;
    event_type: EventType;
    summary: string;
    occurred_at: string;
    source: string;
    sha: string | null;
  }>;

  type Row = (typeof rows)[number];
  interface MergedRow extends Row {
    sources: Set<"local" | "github">;
    /** Local observation wins: it carries the true Git author date. */
    displayAt: string;
    primaryId: number;
  }

  // Pass 1: group commit observations by Project + SHA; keep every other
  // event as its own entry untouched.
  type Entry = { kind: "commit"; merged: MergedRow } | { kind: "plain"; row: Row };
  const entries: Entry[] = [];
  const commitIndex = new Map<string, MergedRow>();
  for (const row of rows) {
    const isLocalCommit = row.event_type === "commit_observed";
    const isGithubCommit = row.event_type === "github_commit_observed";
    if ((!isLocalCommit && !isGithubCommit) || row.project_id == null || row.sha == null) {
      entries.push({ kind: "plain", row });
      continue;
    }
    const key = `${row.project_id}:${row.sha}`;
    let merged = commitIndex.get(key);
    if (!merged) {
      merged = {
        ...row,
        sources: new Set([isGithubCommit ? "github" : "local"]),
        displayAt: row.occurred_at,
        primaryId: row.id,
      };
      commitIndex.set(key, merged);
      entries.push({ kind: "commit", merged });
      continue;
    }
    // Second observation of the same logical commit: merge, do not emit.
    merged.sources.add(isGithubCommit ? "github" : "local");
    // Timestamp precedence: the LOCAL observation carries the true Git
    // author date captured at scan time in the machine's original zone;
    // prefer it so a later GitHub refresh cannot make an old commit look
    // newly active.
    if (isLocalCommit && !merged.sources.has("local")) {
      merged.displayAt = row.occurred_at;
      merged.primaryId = row.id;
    } else if (isLocalCommit) {
      merged.displayAt = row.occurred_at;
    }
  }

  // Pass 2: emit in the SQL order (stable), re-inserting merged rows at
  // their chosen display timestamp position.
  return entries
    .map((entry) => {
      if (entry.kind === "plain") {
        const row = entry.row;
        return {
          id: row.id,
          projectId: row.project_id ?? 0,
          localRepositoryId: row.local_repository_id ?? 0,
          projectName: row.project_name ?? "(unknown)",
          eventType: row.event_type,
          summary: row.summary,
          occurredAt: row.occurred_at,
          source: row.source,
        } satisfies ActivityEventDto;
      }
      const m = entry.merged;
      const dual = m.sources.has("local") && m.sources.has("github");
      return {
        id: m.primaryId,
        projectId: m.project_id ?? 0,
        localRepositoryId: m.local_repository_id ?? 0,
        projectName: m.project_name ?? "(unknown)",
        eventType: m.event_type,
        summary: m.summary,
        occurredAt: m.displayAt,
        source: dual ? "LOCAL + GITHUB" : [...m.sources][0] === "github" ? "GITHUB" : "LOCAL",
        sha: m.sha ?? undefined,
      } satisfies ActivityEventDto;
    })
    .sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id,
    )
    .slice(0, 200);
}

/**
 * Cursor-paginated variant of the logical activity feed used by the
 * Activity page's "Load more" flow.
 *
 * Design: DELEGATES to listActivity() — the exact function whose commit
 * overlap semantics the owner accepted — and slices the LOGICAL feed.
 * This structurally guarantees the dedup invariant: merging happens over
 * the complete filtered dataset BEFORE any page is cut, so a LOCAL +
 * GITHUB pair can never straddle a page boundary as two rows, pages are
 * always exactly up-to-`limit` meaningful rows, and repeated Load-more
 * walks the feed without duplicates or disappearing logical rows.
 *
 * Cursor semantics (deterministic): "occurred_at|id" of the last row of
 * the previous page; ids are strictly increasing so the pair uniquely
 * addresses a position even under timestamp ties. Resolution finds the
 * row's index in the freshly computed feed; if that row has since been
 * pruned, the position falls back to counting strictly-newer rows, keeping
 * pages stable under new inserts at the head.
 */
export function listActivityPaged(filters: {
  projectId?: number;
  repositoryId?: number;
  from?: string;
  to?: string;
  limit?: number;
  /** Opaque cursor "occurred_at|id" from the previous page. */
  cursor?: string | null;
}): { rows: ActivityEventDto[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const all = listActivity({
    projectId: filters.projectId,
    repositoryId: filters.repositoryId,
    from: filters.from,
    to: filters.to,
  });

  let startIndex = 0;
  if (filters.cursor) {
    const separator = filters.cursor.lastIndexOf("|");
    const at = separator >= 0 ? filters.cursor.slice(0, separator) : "";
    const id = separator >= 0 ? Number(filters.cursor.slice(separator + 1)) : NaN;
    const idx = all.findIndex(
      (row) => row.occurredAt === at && row.id === id,
    );
    if (idx >= 0) {
      startIndex = idx + 1;
    } else {
      // Cursor row no longer present (pruned): fall back to counting
      // strictly-newer logical rows so the position stays stable.
      startIndex = all.filter(
        (row) =>
          row.occurredAt.localeCompare(at) > 0 ||
          (row.occurredAt === at && row.id > id),
      ).length;
    }
  }

  const rows = all.slice(startIndex, startIndex + limit);
  const last = rows[rows.length - 1];
  const nextCursor =
    last != null && startIndex + limit < all.length
      ? `${last.occurredAt}|${last.id}`
      : null;
  return { rows, nextCursor };
}

/**
 * Project-owned event persistence (V1.1). Fingerprints are project-scoped:
 * "p{projectId}:{scope}:{detail}". When a local binding originated the
 * event, its id is stored on the row; project-level events pass null.
 */
export function persistActivityEventsDirect(
  projectId: number,
  events: DerivedEvent[],
  repositoryId: number | null = null,
): void {
  if (events.length === 0) return;
  const db = getDb();
  const scope = repositoryId ?? projectId;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO activity_events
      (project_id, local_repository_id, event_type, summary, occurred_at, source, fingerprint, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    stmt.run(
      projectId,
      repositoryId,
      event.eventType,
      event.summary,
      event.occurredAt,
      event.eventType.startsWith("github_") ? "user" : "scan",
      `p${projectId}:${scope}:${event.fingerprint.replace(/^p\d+:\d+:/, "")}`,
      JSON.stringify(event.metadata),
    );
  }
}
