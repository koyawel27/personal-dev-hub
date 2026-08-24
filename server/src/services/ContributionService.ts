import type {
  CommitDto,
  ContributionDayDto,
  ContributionView,
  DailyDetailResponse,
} from "../../../shared/api-types.js";
import { getDb } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Local commits keyed by day. A SHA observed in two local bindings appears
 * once per row set here; the DISTINCT below collapses it per day.
 */
function localRowsByDay(from: string | null, to: string | null): Map<string, Map<string, string>> {
  const clauses: string[] = ["committed_at IS NOT NULL"];
  const params: string[] = [];
  if (from) {
    clauses.push("committed_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("committed_at <= ?");
    params.push(to);
  }
  const rows = getDb()
    .prepare(
      `SELECT substr(committed_at, 1, 10) AS day, commit_sha AS sha
       FROM commits
       WHERE ${clauses.join(" AND ")}`,
    )
    .all(...params) as Array<{ day: string; sha: string }>;
  const byDay = new Map<string, Map<string, string>>();
  for (const row of rows) {
    let shas = byDay.get(row.day);
    if (!shas) {
      shas = new Map<string, string>();
      byDay.set(row.day, shas);
    }
    if (!shas.has(row.sha.toLowerCase())) shas.set(row.sha.toLowerCase(), row.sha);
  }
  return byDay;
}

/**
 * GitHub-side commits from tracked github_commits storage, excluding SHAs
 * already known locally (dedup rule: identity + SHA).
 */
function githubRowsByDay(from: string | null, to: string | null): Map<string, Map<string, string>> {
  const clauses: string[] = ["gc.committed_at IS NOT NULL"];
  const params: string[] = [];
  if (from) {
    clauses.push("gc.committed_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("gc.committed_at <= ?");
    params.push(to);
  }
  const rows = getDb()
    .prepare(
      `SELECT substr(gc.committed_at, 1, 10) AS day,
              gc.commit_sha AS sha
       FROM github_commits gc
       WHERE ${clauses.join(" AND ")}`,
    )
    .all(...params) as Array<{ day: string; sha: string }>;

  // Locally known SHAs (any binding) are excluded from the GitHub lens.
  const known = new Set(
    (getDb().prepare("SELECT DISTINCT commit_sha FROM commits").all() as Array<{
      commit_sha: string;
    }>).map((row) => row.commit_sha.toLowerCase()),
  );

  const byDay = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const lower = row.sha.toLowerCase();
    if (known.has(lower)) continue;
    let shas = byDay.get(row.day);
    if (!shas) {
      shas = new Map<string, string>();
      byDay.set(row.day, shas);
    }
    if (!shas.has(lower)) shas.set(lower, row.sha);
  }
  return byDay;
}

/**
 * V1.1 contribution aggregation with honest per-source views:
 *
 * - LOCAL:    commits discovered from local repository bindings.
 * - GITHUB:   tracked-commit storage from selected GitHub bindings,
 *             excluding SHAs already counted as local.
 * - COMBINED: union of both datasets; a commit observed locally AND on
 *             GitHub counts once.
 *
 * This is NOT the user's complete GitHub contribution graph — only tracked
 * repositories' commits are represented, and counts prioritize correctness
 * over impressive numbers.
 */
export function contributionDays(
  from: string | null,
  to: string | null,
  view: ContributionView = "combined",
): ContributionDayDto[] {
  const locals = view === "github" ? new Map<string, Map<string, string>>() : localRowsByDay(from, to);
  const gh = view === "local" ? new Map<string, Map<string, string>>() : githubRowsByDay(from, to);

  const days = new Map<string, ContributionDayDto>();
  const addDay = (day: string): ContributionDayDto => {
    let dto = days.get(day);
    if (!dto) {
      dto = { date: day, total: 0, localCount: 0, githubCount: 0 };
      days.set(day, dto);
    }
    return dto;
  };

  for (const [day, shas] of locals) {
    addDay(day).localCount = shas.size;
  }
  for (const [day, shas] of gh) {
    addDay(day).githubCount = shas.size;
  }
  for (const dto of days.values()) {
    dto.total = dto.localCount + dto.githubCount;
  }

  return [...days.values()]
    .filter((dto) => dto.total > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Pure deduplication helper retained for tests and future enrichment paths:
 * given GitHub per-day SHA lists and the set of SHAs already observed
 * locally, returns the GitHub-only counts per day.
 */
export function mergeGithubOnly(
  githubDays: { date: string; shas: string[] }[],
  locallyKnownShas: Set<string>,
): { date: string; count: number }[] {
  const counts = new Map<string, number>();
  let contributed = false;
  for (const day of githubDays) {
    for (const sha of day.shas) {
      if (locallyKnownShas.has(sha.toLowerCase())) continue;
      counts.set(day.date, (counts.get(day.date) ?? 0) + 1);
      contributed = true;
    }
  }
  if (!contributed) return [];
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function dailyDetail(day: string, view: ContributionView = "combined"): DailyDetailResponse {
  if (!DAY_PATTERN.test(day)) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "Day must be formatted as YYYY-MM-DD.",
    );
  }

  type Entry = { projectId: number; projectName: string; source: "local" | "github"; commits: CommitDto[] };
  const byProject = new Map<number, Entry>();
  const seenShas = new Set<string>();
  let totalCommits = 0;

  if (view !== "github") {
    const rows = getDb()
      .prepare(
        `SELECT c.local_repository_id AS repositoryId,
                lr.project_id AS projectId,
                p.name AS projectName,
                c.commit_sha AS sha,
                c.subject,
                c.author_name AS authorName,
                c.committed_at AS committedAt
         FROM commits c
         JOIN local_repositories lr ON lr.id = c.local_repository_id
         LEFT JOIN projects p ON p.id = lr.project_id
         WHERE c.committed_at IS NOT NULL AND substr(c.committed_at, 1, 10) = ?
         ORDER BY p.name COLLATE NOCASE ASC, c.committed_at DESC`,
      )
      .all(day) as Array<{
      repositoryId: number;
      projectId: number | null;
      projectName: string | null;
      sha: string;
      subject: string;
      authorName: string | null;
      committedAt: string;
    }>;
    for (const row of rows) {
      const key = row.projectId ?? row.repositoryId;
      let entry = byProject.get(key);
      if (!entry) {
        entry = {
          projectId: key,
          projectName: row.projectName ?? "(unknown project)",
          source: "local",
          commits: [],
        };
        byProject.set(key, entry);
      }
      entry.commits.push({
        sha: row.sha,
        shortSha: row.sha.slice(0, 7),
        subject: row.subject,
        authorName: row.authorName,
        committedAt: row.committedAt,
      });
      if (!seenShas.has(row.sha.toLowerCase())) {
        seenShas.add(row.sha.toLowerCase());
        totalCommits += 1;
      }
    }
  }

  if (view !== "local") {
    // Exclude SHAs already seen in this response's local section when
    // combining; for the pure GITHUB view include all stored commits.
    const rows = getDb()
      .prepare(
        `SELECT gc.project_id AS projectId,
                p.name AS projectName,
                gc.commit_sha AS sha,
                gc.subject,
                gc.author_name AS authorName,
                gc.committed_at AS committedAt
         FROM github_commits gc
         JOIN projects p ON p.id = gc.project_id
         WHERE gc.committed_at IS NOT NULL AND substr(gc.committed_at, 1, 10) = ?
         ORDER BY p.name COLLATE NOCASE ASC, gc.committed_at DESC`,
      )
      .all(day) as Array<{
      projectId: number;
      projectName: string;
      sha: string;
      subject: string | null;
      authorName: string | null;
      committedAt: string;
    }>;
    for (const row of rows) {
      const lower = row.sha.toLowerCase();
      if (view === "combined" && seenShas.has(lower)) continue;
      let entry = byProject.get(row.projectId);
      if (!entry) {
        entry = {
          projectId: row.projectId,
          projectName: row.projectName,
          source: "github",
          commits: [],
        };
        byProject.set(row.projectId, entry);
      }
      entry.commits.push({
        sha: row.sha,
        shortSha: row.sha.slice(0, 7),
        subject: row.subject ?? "(no subject)",
        authorName: row.authorName,
        committedAt: row.committedAt,
      });
      if (!seenShas.has(lower)) {
        seenShas.add(lower);
        totalCommits += 1;
      }
    }
  }

  return {
    date: day,
    totalCommits,
    view,
    projects: [...byProject.values()].map((entry) => ({
      repositoryId: entry.projectId,
      projectName: entry.projectName,
      commits: entry.commits,
    })),
  };
}
