import { getDb } from "../db/client.js";
import { runExecFile } from "../lib/processRunner.js";
import { mergeGithubOnly } from "./ContributionService.js";
import { resolveGhPath } from "./GitHubService.js";

const GH_TIMEOUT_MS = 12_000;
const GH_MAX_COMMITS = 100;

type GhCommit = {
  sha?: unknown;
  commit?: { author?: { date?: unknown }; committer?: { date?: unknown } };
};

export type GithubDayShas = { date: string; shas: string[] };

/**
 * Optional GitHub enrichment for the Contributions page.
 *
 * Honesty rules (spec sections 9.2/9.4):
 * - Only commits whose SHA is NOT already known locally contribute
 *   (deduplication via mergeGithubOnly in ContributionService).
 * - Any failure resolves to null: local data stays untouched and the UI
 *   labels the view Local-only.
 */
async function fetchGithubDayShas(
  owner: string,
  repository: string,
): Promise<GithubDayShas[] | null> {
  const ghPath = resolveGhPath();
  if (!ghPath) return null;
  try {
    const result = await runExecFile(
      ghPath,
      ["api", `repos/${owner}/${repository}/commits?per_page=${GH_MAX_COMMITS}`],
      { timeout: GH_TIMEOUT_MS, windowsHide: true },
    );
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout) as GhCommit[];
    if (!Array.isArray(parsed)) return null;

    const byDay = new Map<string, Set<string>>();
    for (const entry of parsed) {
      const sha = typeof entry.sha === "string" ? entry.sha : null;
      const iso =
        typeof entry.commit?.author?.date === "string"
          ? entry.commit.author.date
          : typeof entry.commit?.committer?.date === "string"
            ? entry.commit.committer.date
            : null;
      if (!sha || !iso || !/^\d{4}-\d{2}-\d{2}T/.test(iso)) continue;
      const day = iso.slice(0, 10);
      const shas = byDay.get(day) ?? new Set<string>();
      shas.add(sha);
      byDay.set(day, shas);
    }
    return [...byDay.entries()]
      .map(([date, shas]) => ({ date, shas: [...shas] }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

/** Primary GitHub identity across tracked repositories, or null. */
function primaryGitHubTarget(): { owner: string; repository: string } | null {
  const row = getDb()
    .prepare(
      `SELECT r.owner, r.repository_name
       FROM git_remotes r
       WHERE r.owner IS NOT NULL AND r.repository_name IS NOT NULL
       ORDER BY r.is_primary DESC, r.local_repository_id ASC
       LIMIT 1`,
    )
    .get() as { owner: string; repository_name: string } | undefined;
  return row ? { owner: row.owner, repository: row.repository_name } : null;
}

/**
 * GitHub-only per-day counts within [from, to], or null when enrichment is
 * unavailable or adds nothing beyond locally known commits. Never throws.
 */
export async function githubOnlyCounts(
  from: string | null,
  to: string | null,
): Promise<{ date: string; count: number }[] | null> {
  try {
    const target = primaryGitHubTarget();
    if (!target) return null;

    const days = await fetchGithubDayShas(target.owner, target.repository);
    if (!days || days.length === 0) return null;

    const known = new Set(
      (getDb()
        .prepare("SELECT DISTINCT commit_sha FROM commits")
        .all() as { commit_sha: string }[]).map((row) => row.commit_sha),
    );
    const counts = mergeGithubOnly(days, known).filter((entry) => {
      if (from && entry.date < from.slice(0, 10)) return false;
      if (to && entry.date > to.slice(0, 10)) return false;
      return true;
    });
    return counts.length > 0 ? counts : null;
  } catch {
    return null;
  }
}
