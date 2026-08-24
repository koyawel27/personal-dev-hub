import { getDb, nowIso } from "../db/client.js";
import {
  fetchRecentCommits,
  getGitHubStatus,
  listAccountRepositories,
} from "./GitHubService.js";
import { persistActivityEventsDirect } from "./ActivityService.js";
import { parseGitHubRemote } from "../../../shared/github-remote.js";

/**
 * GitHub picker + refresh orchestration (V1.1).
 *
 * The picker merges three sources of truth:
 * - the account listing from gh (owner + collaborator + org membership),
 * - known github_repositories cache rows,
 * - local-copy detection via git_remotes identity matching.
 */

export type PickerEntry = {
  owner: string;
  name: string;
  fullName: string;
  visibility: string | null;
  language: string | null;
  description: string | null;
  archived: boolean;
  fork: boolean;
  /** owner | collaborator | organization_member (derived in buildPicker). */
  affiliation: string | null;
  pushedAt: string | null;
  tracked: boolean;
  /** Local copy detected for this identity (primary path). */
  localCopyPath: string | null;
};

type RemoteIdentityRow = {
  url: string;
  local_path: string;
  project_rank: number;
};

function localCopiesByFullName(): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT r.url, lr.local_path, MIN(lr.id) AS project_rank
       FROM git_remotes r
       JOIN local_repositories lr ON lr.id = r.local_repository_id
       GROUP BY lower(r.url), lower(lr.local_path)`,
    )
    .all() as RemoteIdentityRow[];
  const map = new Map<string, string>();
  for (const row of rows) {
    const parsed = parseGitHubRemote(row.url);
    if (!parsed) continue;
    const key = `${parsed.owner.toLowerCase()}/${parsed.repository.toLowerCase()}`;
    if (!map.has(key)) map.set(key, row.local_path);
  }
  return map;
}

/**
 * Build picker data. Returns { entries, available } where available is null
 * when gh/network made listing impossible (the UI shows a retryable error
 * but still renders cached/tracked rows).
 */
export async function buildPicker(): Promise<{
  entries: PickerEntry[];
  available: boolean;
}> {
  const db = getDb();
  const status = await getGitHubStatus();
  const listed = status.installed && status.authenticated ? await listAccountRepositories() : null;

  const locals = localCopiesByFullName();
  const entries = new Map<string, PickerEntry>();

  const cachedRows = db
    .prepare(
      `SELECT owner, name, full_name, visibility, language, description,
              archived, fork, last_pushed_at, project_id
       FROM github_repositories`,
    )
    .all() as Array<{
    owner: string;
    name: string;
    full_name: string;
    visibility: string | null;
    language: string | null;
    description: string | null;
    archived: number | null;
    fork: number | null;
    last_pushed_at: string | null;
    project_id: number | null;
  }>;

  const keyOf = (owner: string, name: string): string =>
    `${owner.toLowerCase()}/${name.toLowerCase()}`;

  // Cached/known rows first (works offline; includes tracked ones).
  for (const row of cachedRows) {
    const key = keyOf(row.owner, row.name);
    entries.set(key, {
      owner: row.owner,
      name: row.name,
      fullName: row.full_name || `${row.owner}/${row.name}`,
      visibility: row.visibility,
      language: row.language,
      description: row.description,
      archived: row.archived === 1,
      fork: row.fork === 1,
      affiliation: null,
      pushedAt: row.last_pushed_at,
      tracked: row.project_id != null,
      localCopyPath: locals.get(key) ?? null,
    });
  }

  // Merge live account listing when reachable. Affiliation is derived here
  // where the authenticated account name is known: repos owned by the
  // viewer are "owner"; push-capable repos from others are "collaborator";
  // everything else came via organization membership.
  const account = status.accountName?.toLowerCase() ?? null;
  if (listed != null) {
    for (const repo of listed) {
      const key = keyOf(repo.owner, repo.name);
      const affiliation =
        account && repo.owner.toLowerCase() === account
          ? "owner"
          : repo.viewerCanPush
            ? "collaborator"
            : "organization_member";
      const existing = entries.get(key);
      if (existing) {
        entries.set(key, {
          ...existing,
          visibility: repo.visibility ?? existing.visibility,
          language: repo.language ?? existing.language,
          description: repo.description ?? existing.description,
          archived: repo.archived || existing.archived,
          fork: repo.fork || existing.fork,
          affiliation,
          pushedAt: repo.pushedAt ?? existing.pushedAt,
        });
      } else {
        entries.set(key, {
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          visibility: repo.visibility,
          language: repo.language,
          description: repo.description,
          archived: repo.archived,
          fork: repo.fork,
          affiliation,
          pushedAt: repo.pushedAt,
          tracked: false,
          localCopyPath: locals.get(key) ?? null,
        });
      }
    }
  }

  return {
    entries: [...entries.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }),
    ),
    available: listed != null,
  };
}

/**
 * Refresh one tracked binding: metadata + bounded commits. Failure modes are
 * isolated — a dead binding is marked stale, never thrown to the caller's
 * page, and local functionality is untouched.
 */
export async function refreshTrackedBinding(githubRepositoryId: number): Promise<{
  ok: boolean;
  reason?: string;
  newCommits?: number;
}> {
  const db = getDb();
  const binding = db
    .prepare(
      `SELECT id, owner, name, full_name, project_id FROM github_repositories WHERE id = ?`,
    )
    .get(githubRepositoryId) as
    | { id: number; owner: string; name: string; full_name: string; project_id: number | null }
    | undefined;
  if (!binding || binding.project_id == null) {
    return { ok: false, reason: "not-tracked" };
  }
  const projectId = binding.project_id;

  const commits = await fetchRecentCommits(binding.owner, binding.name);
  if (commits == null) {
    // Mark stale; keep cached data.
    db.prepare(
      "UPDATE github_repositories SET last_refreshed_at = ? WHERE id = ?",
    ).run(nowIso(), binding.id);
    return { ok: false, reason: "unavailable" };
  }

  let inserted = 0;
  const observedAt = nowIso();
  for (const commit of commits) {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO github_commits
           (project_id, github_repository_id, commit_sha, subject, author_name, committed_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        binding.id,
        commit.sha,
        commit.subject,
        commit.authorName,
        commit.committedAt,
        observedAt,
      );
    if (Number(result.changes) > 0) inserted += 1;
  }

  // Activity events only for genuinely NEW SHAs — routine refreshes that
  // add nothing emit nothing (noise rule).
  if (inserted > 0) {
    persistActivityEventsDirect(projectId, [
      ...commits.slice(0, inserted).map((commit) => ({
        eventType: "github_commit_observed" as const,
        summary: commit.subject ?? `Commit ${commit.sha.slice(0, 7)}`,
        occurredAt: commit.committedAt ?? observedAt,
        fingerprint: `${binding.id}:github_commit:${commit.sha}`,
        metadata: {
          sha: commit.sha,
          authorName: commit.authorName,
          source: "github" as const,
        },
      })),
    ]);
  }

  db.prepare(
    "UPDATE github_repositories SET last_refreshed_at = ? WHERE id = ?",
  ).run(observedAt, binding.id);
  return { ok: true, newCommits: inserted };
}
