import type {
  CommitDto,
  ContributionDayDto,
  DailyDetailResponse,
} from "../../../shared/api-types.js";
import { getDb } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Contribution aggregation over locally observed commits.
 *
 * Double-count rule (spec section 9.4): COUNT(DISTINCT commit_sha) makes a
 * commit observed in two repositories count once per day. Grouping uses the
 * recorded offset-local date (first 10 chars of the ISO-with-offset value).
 */
export function contributionDays(
  from: string | null,
  to: string | null,
): ContributionDayDto[] {
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
      `SELECT substr(committed_at, 1, 10) AS day,
              COUNT(DISTINCT commit_sha) AS total
       FROM commits
       WHERE ${clauses.join(" AND ")}
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(...params) as { day: string; total: number }[];
  return rows.map((row) => ({
    date: row.day,
    total: row.total,
    localCount: row.total,
    githubCount: 0,
  }));
}

export function dailyDetail(day: string): DailyDetailResponse {
  if (!DAY_PATTERN.test(day)) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "Day must be formatted as YYYY-MM-DD.",
    );
  }

  const rows = getDb()
    .prepare(
      `SELECT c.local_repository_id AS repositoryId,
              lr.name AS projectName,
              c.commit_sha AS sha,
              c.subject,
              c.author_name AS authorName,
              c.committed_at AS committedAt
       FROM commits c
       JOIN local_repositories lr ON lr.id = c.local_repository_id
       WHERE c.committed_at IS NOT NULL AND substr(c.committed_at, 1, 10) = ?
       ORDER BY lr.name COLLATE NOCASE ASC, c.committed_at DESC`,
    )
    .all(day) as {
    repositoryId: number;
    projectName: string;
    sha: string;
    subject: string;
    authorName: string | null;
    committedAt: string;
  }[];

  const byProject = new Map<number, { repositoryId: number; projectName: string; commits: CommitDto[] }>();
  const seenShas = new Set<string>();
  let totalCommits = 0;
  for (const row of rows) {
    let entry = byProject.get(row.repositoryId);
    if (!entry) {
      entry = { repositoryId: row.repositoryId, projectName: row.projectName, commits: [] };
      byProject.set(row.repositoryId, entry);
    }
    entry.commits.push({
      sha: row.sha,
      shortSha: row.sha.slice(0, 7),
      subject: row.subject,
      authorName: row.authorName,
      committedAt: row.committedAt,
    });
    if (!seenShas.has(row.sha)) {
      seenShas.add(row.sha);
      totalCommits += 1;
    }
  }

  return {
    date: day,
    totalCommits,
    projects: [...byProject.values()],
  };
}
