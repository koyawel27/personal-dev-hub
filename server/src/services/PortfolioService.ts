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

/**
 * Selected-work view generated from tracked data (spec section 10).
 *
 * V1.1: sourced from PROJECTS so GitHub-only projects are eligible without
 * a local clone (major owner goal). Ordering: explicit portfolio_order
 * ascending first, then unordered flagged projects by name.
 */
export function listPortfolio(): PortfolioItemDto[] {
  const db = getDb();
  type Row = {
    id: number;
    name: string;
    project_status: ProjectStatus | null;
    project_type: ProjectType | null;
    project_note: string | null;
    portfolio_order: number | null;
    gh_full_name: string | null;
    gh_html_url: string | null;
    gh_language: string | null;
    primary_local_path: string | null;
  };
  const rows = db
    .prepare(
      `SELECT p.id, p.name,
              p.project_status, p.project_type, p.project_note,
              p.portfolio_order,
              g.full_name AS gh_full_name,
              g.html_url AS gh_html_url,
              g.language AS gh_language,
              (SELECT lr.local_path FROM local_repositories lr
                WHERE lr.project_id = p.id
                ORDER BY lr.is_primary DESC, lr.id ASC LIMIT 1) AS primary_local_path
       FROM projects p
       LEFT JOIN github_repositories g ON g.project_id = p.id
       WHERE p.include_in_portfolio = 1
       ORDER BY (p.portfolio_order IS NULL) ASC,
                p.portfolio_order ASC,
                p.name COLLATE NOCASE ASC,
                p.id ASC`,
    )
    .all() as Row[];

  const commitDates = db.prepare(
    `SELECT MIN(c.committed_at) AS first_commit_at,
            MAX(c.committed_at) AS latest_commit_at
     FROM commits c JOIN local_repositories lr ON lr.id = c.local_repository_id
     WHERE lr.project_id = ? AND c.committed_at IS NOT NULL`,
  );
  const ghCommitDates = db.prepare(
    `SELECT MIN(committed_at) AS first_commit_at,
            MAX(committed_at) AS latest_commit_at
     FROM github_commits WHERE project_id = ? AND committed_at IS NOT NULL`,
  );
  const lastMeaningful = db.prepare(
    `SELECT MAX(occurred_at) AS at FROM activity_events
     WHERE project_id = ?
       AND event_type IN ('commit_observed','github_commit_observed',
                          'working_tree_dirty','working_tree_clean',
                          'branch_changed','ahead_changed','behind_changed')`,
  );

  return rows.map((row) => {
    const hasLocal = row.primary_local_path != null;

    // Commit window spans both sources when available.
    const localDates = hasLocal
      ? (commitDates.get(row.id) as { first_commit_at: string | null; latest_commit_at: string | null })
      : { first_commit_at: null, latest_commit_at: null };
    const githubDates =
      row.gh_full_name != null
        ? (ghCommitDates.get(row.id) as { first_commit_at: string | null; latest_commit_at: string | null })
        : { first_commit_at: null, latest_commit_at: null };
    const firsts = [localDates.first_commit_at, githubDates.first_commit_at].filter(
      (value): value is string => value != null,
    );
    const latests = [localDates.latest_commit_at, githubDates.latest_commit_at].filter(
      (value): value is string => value != null,
    );

    // Technology hints: local manifest probes; GitHub's reported primary
    // language only as an explicitly-GitHub hint for items without a local
    // copy to probe (owner decision Q4 — labeled metadata, not analysis).
    let hints: string[] = [];
    if (hasLocal) {
      hints = technologyHintsFor(row.primary_local_path!);
    } else if (row.gh_language) {
      hints = [`GitHub: ${row.gh_language}`];
    }

    const activity = lastMeaningful.get(row.id) as { at: string | null };

    return {
      id: row.id,
      name: row.name,
      sourceState: derivePortfolioState(hasLocal, row.gh_full_name != null),
      projectType: row.project_type,
      projectStatus: row.project_status,
      projectNote: row.project_note,
      githubHtmlUrl:
        row.gh_html_url ??
        (row.gh_full_name ? `https://github.com/${row.gh_full_name}` : null),
      portfolioOrder: row.portfolio_order,
      technologyHints: hints,
      firstCommitAt: firsts.length ? firsts.sort()[0] : null,
      latestCommitAt: latests.length ? latests.sort().at(-1)! : null,
      lastMeaningfulAt: activity.at ?? (latests.length ? latests.sort().at(-1)! : null),
    };
  });
}

function derivePortfolioState(
  hasLocal: boolean,
  hasGithub: boolean,
): PortfolioItemDto["sourceState"] {
  // Portfolio items are include_in_portfolio projects; a NO SOURCE item can
  // only be a pre-repair ghost, never a resting state (Q1 invariant).
  if (hasLocal && hasGithub) return "LOCAL + GITHUB";
  if (hasLocal) return "LOCAL ONLY";
  return hasGithub ? "GITHUB ONLY" : "NO SOURCE";
}
