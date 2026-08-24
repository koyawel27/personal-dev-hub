import type {
  CommitDto,
  ContributionDayDto,
  ContributionDedup,
  ContributionTotals,
  ContributionView,
  DailyDetailResponse,
} from "../../../shared/api-types.js";
import { getDb } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}$/;

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
 * GitHub-side commits from tracked github_commits storage. The GITHUB lens
 * counts GitHub observations independently (owner definition): overlap with
 * local observation is collapsed only in the COMBINED lens.
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

  const byDay = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const lower = row.sha.toLowerCase();
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

  type Row = {
    projectId: number;
    projectName: string;
    sha: string;
    subject: string;
    authorName: string | null;
    committedAt: string;
    source: "local" | "github";
  };
  const rows: Row[] = [];

  if (view !== "github") {
    const locals = getDb()
      .prepare(
        `SELECT lr.project_id AS projectId,
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
      projectId: number | null;
      projectName: string | null;
      sha: string;
      subject: string;
      authorName: string | null;
      committedAt: string;
    }>;
    for (const row of locals) {
      rows.push({
        projectId: row.projectId ?? -1,
        projectName: row.projectName ?? "(unknown project)",
        sha: row.sha,
        subject: row.subject,
        authorName: row.authorName,
        committedAt: row.committedAt,
        source: "local",
      });
    }
  }

  if (view !== "local") {
    const githubs = getDb()
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
    for (const row of githubs) {
      rows.push({
        projectId: row.projectId,
        projectName: row.projectName,
        sha: row.sha,
        subject: row.subject ?? "(no subject)",
        authorName: row.authorName,
        committedAt: row.committedAt,
        source: "github",
      });
    }
  }

  // Collapse by SHA across lenses (identity+SHA dedup). A commit observed by
  // BOTH stores keeps one entry whose source becomes LOCAL + GITHUB — but a
  // SHA claimed by a DIFFERENT project (independent twin repo) stays with
  // its first observation, preserving the established cross-repo rule.
  type UniqueCommit = Row & { sources: Set<string> };
  const bySha = new Map<string, UniqueCommit>();
  for (const row of rows) {
    const key = row.sha.toLowerCase();
    const existing = bySha.get(key);
    if (existing) {
      if (existing.projectId === row.projectId) {
        existing.sources.add(row.source);
      }
      continue;
    }
    bySha.set(key, { ...row, sources: new Set([row.source]) });
  }

  const byProject = new Map<
    number,
    { repositoryId: number; projectName: string; source: string; commits: CommitDto[] }
  >();
  for (const commit of bySha.values()) {
    let entry = byProject.get(commit.projectId);
    if (!entry) {
      entry = {
        repositoryId: commit.projectId,
        projectName: commit.projectName,
        source: "",
        commits: [],
      };
      byProject.set(commit.projectId, entry);
    }
    const dual = commit.sources.has("local") && commit.sources.has("github");
    entry.commits.push({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      subject: commit.subject,
      authorName: commit.authorName,
      committedAt: commit.committedAt,
      ...(dual || commit.sources.size > 1 ? { source: "LOCAL + GITHUB" } : { source: [...commit.sources][0] }),
    });
  }
  for (const entry of byProject.values()) {
    const sources = new Set(entry.commits.map((commit) => String((commit as { source?: string }).source)));
    entry.source =
      sources.size > 1 || sources.has("LOCAL + GITHUB")
        ? "LOCAL + GITHUB"
        : ([...sources][0] ?? "local");
    entry.commits.sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? ""));
  }

  return {
    date: day,
    totalCommits: bySha.size,
    view,
    projects: [...byProject.values()],
  };
}

// ---------------------------------------------------------------------------
// Year activity view (owner Contributions pass): GitHub-familiar year grid
// with compact honest statistics, dedup transparency, and a years list.
// All aggregation is set-based SQL + in-memory maps — no per-day or
// per-project N+1 queries.
// ---------------------------------------------------------------------------

function yearBounds(year: number): { from: string; to: string } {
  return {
    from: `${year}-01-01T00:00:00Z`,
    to: `${year}-12-31T23:59:59Z`,
  };
}

/** Distinct local SHAs for a year, keyed by day. */
function localYearShas(year: number): Map<string, Set<string>> {
  const { from, to } = yearBounds(year);
  const rows = getDb()
    .prepare(
      `SELECT substr(committed_at, 1, 10) AS day, lower(commit_sha) AS sha
       FROM commits
       WHERE committed_at IS NOT NULL AND committed_at >= ? AND committed_at <= ?`,
    )
    .all(from, to) as Array<{ day: string; sha: string }>;
  const byDay = new Map<string, Set<string>>();
  for (const row of rows) {
    let shas = byDay.get(row.day);
    if (!shas) {
      shas = new Set();
      byDay.set(row.day, shas);
    }
    shas.add(row.sha);
  }
  return byDay;
}

/** Distinct GitHub SHAs for a year, keyed by day. */
function githubYearShas(year: number): Map<string, Set<string>> {
  const { from, to } = yearBounds(year);
  const rows = getDb()
    .prepare(
      `SELECT substr(gc.committed_at, 1, 10) AS day, lower(gc.commit_sha) AS sha
       FROM github_commits gc
       WHERE gc.committed_at IS NOT NULL AND gc.committed_at >= ? AND gc.committed_at <= ?`,
    )
    .all(from, to) as Array<{ day: string; sha: string }>;
  const byDay = new Map<string, Set<string>>();
  for (const row of rows) {
    let shas = byDay.get(row.day);
    if (!shas) {
      shas = new Set();
      byDay.set(row.day, shas);
    }
    shas.add(row.sha);
  }
  return byDay;
}

/**
 * Years holding any tracked commit data (local OR github), newest first.
 * Cheap two-column scan over indexed timestamp text.
 */
export function contributionYears(): number[] {
  const db = getDb();
  const locals = db
    .prepare("SELECT DISTINCT substr(committed_at, 1, 4) AS y FROM commits WHERE committed_at IS NOT NULL")
    .all() as Array<{ y: string }>;
  const githubs = db
    .prepare(
      "SELECT DISTINCT substr(committed_at, 1, 4) AS y FROM github_commits WHERE committed_at IS NOT NULL",
    )
    .all() as Array<{ y: string }>;
  const years = new Set<number>();
  for (const row of [...locals, ...githubs]) {
    if (/^\d{4}$/.test(row.y)) years.add(Number(row.y));
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * Year-scoped contribution response for the selected lens: daily counts for
 * the grid, compact real totals, and combined-view dedup transparency.
 */
export function contributionYear(
  year: number,
  view: ContributionView = "combined",
): {
  year: number;
  source: ContributionView;
  days: ContributionDayDto[];
  totals: ContributionTotals;
  dedup?: ContributionDedup;
} {
  if (!Number.isInteger(year) || !YEAR_PATTERN.test(String(year))) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Year must be a four-digit number.");
  }

  const locals = view === "github" ? new Map<string, Set<string>>() : localYearShas(year);
  const gh = view === "local" ? new Map<string, Set<string>>() : githubYearShas(year);

  // Per-day union under the lens. For COMBINED the day's total is a TRUE
  // set union (a SHA observed by both stores on the same day counts once);
  // local/github counts stay independent for transparency.
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
  let totalCommits = 0;
  for (const [day, dto] of days) {
    if (view === "combined") {
      const union = new Set<string>([
        ...(locals.get(day) ?? []),
        ...(gh.get(day) ?? []),
      ]);
      dto.total = union.size;
    } else {
      dto.total = view === "local" ? dto.localCount : dto.githubCount;
    }
    totalCommits += dto.total;
  }

  // Projects that contributed under the selected lens (bounded grouped query).
  const projectCount = (() => {
    const db = getDb();
    const { from, to } = yearBounds(year);
    const set = new Set<number>();
    if (view !== "github") {
      const rows = db
        .prepare(
          `SELECT DISTINCT lr.project_id AS pid FROM commits c
           JOIN local_repositories lr ON lr.id = c.local_repository_id
           WHERE c.committed_at IS NOT NULL AND lr.project_id IS NOT NULL
             AND c.committed_at >= ? AND c.committed_at <= ?`,
        )
        .all(from, to) as Array<{ pid: number }>;
      for (const row of rows) set.add(row.pid);
    }
    if (view !== "local") {
      const rows = db
        .prepare(
          `SELECT DISTINCT project_id AS pid FROM github_commits
           WHERE committed_at IS NOT NULL AND project_id IS NOT NULL
             AND committed_at >= ? AND committed_at <= ?`,
        )
        .all(from, to) as Array<{ pid: number | null }>;
      for (const row of rows) if (row.pid != null) set.add(row.pid);
    }
    return set.size;
  })();

  // Dedup transparency for the COMBINED lens only. Overlap = distinct SHAs
  // present in BOTH stores within the year — reliably derivable from the
  // identity+SHA model, so we show it rather than guessing.
  let dedup: ContributionDedup | undefined;
  if (view === "combined") {
    const bounds = yearBounds(year);
    let localObserved = 0;
    for (const shas of locals.values()) localObserved += shas.size;
    let githubObserved = 0;
    for (const shas of gh.values()) githubObserved += shas.size;

    const overlapShas = getDb()
      .prepare(
        `SELECT COUNT(DISTINCT lower(l.sha)) AS n
         FROM (
           SELECT DISTINCT commit_sha AS sha FROM commits
           WHERE committed_at IS NOT NULL AND committed_at >= ? AND committed_at <= ?
         ) l
         JOIN (
           SELECT DISTINCT commit_sha AS sha FROM github_commits
           WHERE committed_at IS NOT NULL AND committed_at >= ? AND committed_at <= ?
         ) g ON l.sha = g.sha`,
      )
      .get(bounds.from, bounds.to, bounds.from, bounds.to) as { n: number };
    const overlap = Number(overlapShas.n);

    dedup = {
      localObserved,
      githubObserved,
      overlap,
      combinedUnique: localObserved + githubObserved - overlap,
    };

    // The per-day union is authoritative for the grid; keep the summary
    // consistent with it in case a SHA lands on different days per source.
    if (dedup.combinedUnique !== totalCommits) {
      dedup.combinedUnique = totalCommits;
    }
  }

  return {
    year,
    source: view,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: {
      commits: totalCommits,
      activeDays: days.size,
      projects: projectCount,
    },
    ...(dedup != null ? { dedup } : {}),
  };
}
