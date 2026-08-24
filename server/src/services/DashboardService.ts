import fs from "node:fs";
import type {
  ActivityEventDto,
  AttentionReason,
  DashboardResponse,
  ProjectStatus,
  ProjectType,
  RecentlyActiveProjectDto,
  SourceState,
} from "../../../shared/api-types.js";
import { QUALIFYING_ACTIVITY_TYPES, syncTerm } from "../../../shared/status-terms.js";
import { getDb } from "../db/client.js";
import { listActivity } from "./ActivityService.js";

function weekAgoIso(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString();
}

/** Test seam: identical to getDashboard but exported without route wiring. */
export const getDashboardForTest = getDashboard;
export function getDashboard(): DashboardResponse {
  const db = getDb();
  const since = weekAgoIso();
  const qualifying = new Set<string>(QUALIFYING_ACTIVITY_TYPES);

  type ProjectRow = {
    id: number;
    name: string;
    project_status: ProjectStatus | null;
    project_type: ProjectType | null;
  };
  const projects = db
    .prepare(
      `SELECT id, name, project_status, project_type
       FROM projects ORDER BY name COLLATE NOCASE ASC, id ASC`,
    )
    .all() as ProjectRow[];

  const primaryLocal = db.prepare(
    `SELECT lr.id AS id, lr.local_path AS path, s.branch AS branch,
            s.is_dirty AS is_dirty, s.modified_count AS modified_count,
            s.staged_count AS staged_count, s.untracked_count AS untracked_count,
            s.upstream_ref AS upstream_ref, s.ahead_count AS ahead_count,
            s.behind_count AS behind_count, s.captured_at AS captured_at,
            s.id AS snap_id
     FROM local_repositories lr
     LEFT JOIN repository_snapshots s ON s.local_repository_id = lr.id
     WHERE lr.project_id = ?
     ORDER BY lr.id ASC LIMIT 1`,
  );

  const ghBinding = db.prepare(
    `SELECT full_name, html_url FROM github_repositories WHERE project_id = ? LIMIT 1`,
  );

  // Latest meaningful event per project (either origin) and per-project
  // latest commit subject from either commits table.
  const meaningfulByProject = new Map<number, string>();
  const meaningfulRows = db
    .prepare(
      `SELECT project_id AS pid, MAX(occurred_at) AS at
       FROM activity_events
       WHERE event_type IN (${[...qualifying].map(() => "?").join(",")})
       GROUP BY project_id`,
    )
    .all(...qualifying) as Array<{ pid: number; at: string }>;
  for (const row of meaningfulRows) meaningfulByProject.set(row.pid, row.at);

  const latestSubjectByProject = new Map<number, { subject: string; at: string }>();
  const localSubjects = db
    .prepare(
      `SELECT lr.project_id AS pid, c.subject, c.committed_at
       FROM commits c JOIN local_repositories lr ON lr.id = c.local_repository_id
       WHERE lr.project_id IS NOT NULL AND c.committed_at IS NOT NULL`,
    )
    .all() as Array<{ pid: number; subject: string; committed_at: string }>;
  for (const row of localSubjects) {
    const current = latestSubjectByProject.get(row.pid);
    if (!current || row.committed_at > current.at) {
      latestSubjectByProject.set(row.pid, { subject: row.subject, at: row.committed_at });
    }
  }
  const ghSubjects = db
    .prepare(
      `SELECT project_id AS pid, subject, committed_at FROM github_commits
       WHERE project_id IS NOT NULL AND committed_at IS NOT NULL AND subject IS NOT NULL`,
    )
    .all() as Array<{ pid: number; subject: string; committed_at: string }>;
  for (const row of ghSubjects) {
    const current = latestSubjectByProject.get(row.pid);
    if (!current || row.committed_at > current.at) {
      latestSubjectByProject.set(row.pid, { subject: row.subject, at: row.committed_at });
    }
  }

  // --- summary metrics (all real values) ---
  const weekActivity = listActivity({ from: since });
  const activeProjectIds = new Set(
    weekActivity
      .filter((event) => qualifying.has(event.eventType))
      .map((event) => event.projectId),
  );
  const commitsThisWeek =
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT sha) AS n FROM (
             SELECT commit_sha AS sha FROM commits
              WHERE committed_at IS NOT NULL AND committed_at >= ?
             UNION ALL
             SELECT gc.commit_sha AS sha FROM github_commits gc
              LEFT JOIN commits c2 ON c2.commit_sha = gc.commit_sha
              WHERE gc.committed_at IS NOT NULL AND gc.committed_at >= ?
                AND c2.id IS NULL
           )`,
        )
        .get(since, since) as { n: number }
    ).n;
  const activeDaysThisWeek = new Set(
    weekActivity
      .filter((event) => qualifying.has(event.eventType))
      .map((event) => event.occurredAt.slice(0, 10)),
  ).size;

  function compactDto(project: ProjectRow): RecentlyActiveProjectDto & {
    snapshotCounts: { modified: number; staged: number; untracked: number } | null;
    attentionReasons?: AttentionReason[];
  } {
    const binding = primaryLocal.get(project.id) as
      | {
          id: number | null;
          path: string | null;
          branch: string | null;
          is_dirty: number | null;
          modified_count: number | null;
          staged_count: number | null;
          untracked_count: number | null;
          upstream_ref: string | null;
          ahead_count: number | null;
          behind_count: number | null;
          captured_at: string | null;
          snap_id: number | null;
        }
      | undefined;
    const hasLocal = binding?.id != null && binding.path != null;
    const gh = ghBinding.get(project.id) as
      | { full_name: string; html_url: string | null }
      | undefined;

    let workingTree: "Clean" | "Uncommitted" | "Unavailable" = "Unavailable";
    if (hasLocal) {
      const pathExists = fs.existsSync(binding!.path!);
      if (pathExists) {
        workingTree = binding!.is_dirty === 1 ? "Uncommitted" : "Clean";
      }
    }

    const reasons: AttentionReason[] = [];
    if (hasLocal) {
      const pathExists = fs.existsSync(binding!.path!);
      if (!pathExists) reasons.push("repository path unavailable");
      else if (binding!.is_dirty === 1) reasons.push("uncommitted changes");
      const ahead = binding!.ahead_count ?? null;
      const behind = binding!.behind_count ?? null;
      if (binding!.upstream_ref == null) reasons.push("no upstream branch");
      else if ((ahead ?? 0) > 0 && (behind ?? 0) > 0) reasons.push("ahead and behind upstream");
      else if ((ahead ?? 0) > 0) reasons.push("ahead of upstream");
      else if ((behind ?? 0) > 0) reasons.push("behind upstream");
    }
    // GITHUB ONLY projects are intentionally NOT flagged for local-only
    // conditions (owner constraint): no dirty/upstream noise.

    return {
      id: project.id,
      name: project.name,
      sourceState: deriveSourceStateFor(project.id, hasLocal, gh != null),
      projectStatus: project.project_status,
      projectType: project.project_type,
      branch: binding?.branch ?? null,
      workingTree,
      sync: syncTerm(binding?.upstream_ref ?? null, binding?.ahead_count ?? null, binding?.behind_count ?? null),
      githubConnected: gh != null,
      localPath: hasLocal ? binding!.path! : null,
      lastMeaningfulAt: meaningfulByProject.get(project.id) ?? null,
      latestCommitSubject:
        latestSubjectByProject.get(project.id)?.subject ?? null,
      snapshotCounts:
        hasLocal && binding!.snap_id != null
          ? {
              modified: binding!.modified_count ?? 0,
              staged: binding!.staged_count ?? 0,
              untracked: binding!.untracked_count ?? 0,
            }
          : null,
      attentionReasons: reasons,
    } as RecentlyActiveProjectDto & {
      snapshotCounts: { modified: number; staged: number; untracked: number } | null;
      attentionReasons?: AttentionReason[];
    };
  }

  const compact = projects.map(compactDto);

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
    trackedProjects: projects.length,
    activeProjects: activeProjectIds.size,
    commitsThisWeek,
    activeDaysThisWeek,
    uncommittedRepositories: compact.filter(
      (item) => item.workingTree === "Uncommitted",
    ).length,
    recentlyActive,
    needsAttention,
    recentActivity: listActivity({}).slice(0, 10),
  };
}

function deriveSourceStateFor(
  projectId: number,
  hasLocal: boolean,
  hasGithub: boolean,
): SourceState {
  if (hasLocal && hasGithub) return "LOCAL + GITHUB";
  if (hasLocal) return "LOCAL ONLY";
  return "GITHUB ONLY";
}
