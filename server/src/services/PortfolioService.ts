import fs from "node:fs";
import type {
  PortfolioItemDto,
  ProjectStatus,
  ProjectType,
} from "../../../shared/api-types.js";
import { getDb } from "../db/client.js";

/** Manifest probes for honest technology hints (spec section 10.1 "when available"). */
const TECHNOLOGY_PROBES: Array<{ file: string; label: string }> = [
  { file: "package.json", label: "Node.js" },
  { file: "composer.json", label: "PHP" },
  { file: "pyproject.toml", label: "Python" },
  { file: "requirements.txt", label: "Python" },
  { file: "go.mod", label: "Go" },
  { file: "Cargo.toml", label: "Rust" },
];

function technologyHintsFor(localPath: string): string[] {
  const hints = new Set<string>();
  try {
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) return [];
    const entries = new Set(fs.readdirSync(localPath));
    for (const probe of TECHNOLOGY_PROBES) {
      if (entries.has(probe.file)) hints.add(probe.label);
    }
    for (const entry of entries) {
      if (entry.endsWith(".csproj")) hints.add("C# / .NET");
    }
  } catch {
    // Unreadable path: no hints, never a failure.
  }
  return [...hints];
}

type PortfolioRow = {
  id: number;
  name: string;
  local_path: string;
  project_status: ProjectStatus | null;
  project_type: ProjectType | null;
  project_note: string | null;
  portfolio_order: number | null;
  github_html_url: string | null;
};

/**
 * Selected-work view generated from tracked data (spec section 10).
 * Ordering: explicit portfolio_order ascending first, then unordered
 * flagged projects by name. Local-only projects are first-class here.
 */
export function listPortfolio(): PortfolioItemDto[] {
  const rows = getDb()
    .prepare(
      `SELECT lr.id, lr.name, lr.local_path,
              lr.project_status, lr.project_type, lr.project_note,
              lr.portfolio_order,
              remotes.html_url AS github_html_url
       FROM local_repositories lr
       LEFT JOIN (
         SELECT r.local_repository_id, g.html_url
         FROM git_remotes r
         JOIN github_repositories g ON g.id = r.github_repository_id
         ORDER BY r.is_primary DESC, r.name ASC
       ) remotes ON remotes.local_repository_id = lr.id
       WHERE lr.include_in_portfolio = 1
       ORDER BY (lr.portfolio_order IS NULL) ASC,
                lr.portfolio_order ASC,
                lr.name COLLATE NOCASE ASC,
                lr.id ASC`,
    )
    .all() as PortfolioRow[];

  const dates = getDb()
    .prepare(
      `SELECT MIN(committed_at) AS first_commit_at,
              MAX(committed_at) AS latest_commit_at,
              MAX(first_seen_at) AS last_seen_at
       FROM commits
       WHERE local_repository_id = ? AND committed_at IS NOT NULL`,
    );

  return rows.map((row) => {
    const commitDates = dates.get(row.id) as {
      first_commit_at: string | null;
      latest_commit_at: string | null;
      last_seen_at: string | null;
    };
    // Activity summary: latest known activity event time (meaningful only).
    const activity = getDb()
      .prepare(
        `SELECT MAX(occurred_at) AS at FROM activity_events
         WHERE local_repository_id = ?
           AND event_type IN ('commit_observed','working_tree_dirty',
                              'working_tree_clean','branch_changed',
                              'ahead_changed','behind_changed')`,
      )
      .get(row.id) as { at: string | null };

    return {
      id: row.id,
      name: row.name,
      projectType: row.project_type,
      projectStatus: row.project_status,
      projectNote: row.project_note,
      githubHtmlUrl: row.github_html_url,
      portfolioOrder: row.portfolio_order,
      technologyHints: technologyHintsFor(row.local_path),
      firstCommitAt: commitDates.first_commit_at,
      latestCommitAt: commitDates.latest_commit_at,
      lastMeaningfulAt: activity.at ?? commitDates.last_seen_at,
    };
  });
}
