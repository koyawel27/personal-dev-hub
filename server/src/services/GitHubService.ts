import { parseGitHubRemote, isSafeSegment } from "../../../shared/github-remote.js";
import type { GitHubMetadataDto, GitHubStatusDto } from "../../../shared/api-types.js";
import fs from "node:fs";
import { runExecFile } from "../lib/processRunner.js";

const GH_OPERATIONS = {
  version: ["--version"],
  authStatus: ["auth", "status"],
  user: ["api", "user"],
} as const;

/** Maximum pages of account repositories fetched for the picker (Q2 cap: ~1000). */
const PICKER_MAX_PAGES = 10;
const PICKER_PER_PAGE = 100;

let resolvedGhPath: string | null | undefined;

export function resetGhPathCache(): void {
  resolvedGhPath = undefined;
}

export function resolveGhPath(): string | null {
  if (resolvedGhPath !== undefined) return resolvedGhPath;
  if (process.env.GH_EXECUTABLE && fs.existsSync(process.env.GH_EXECUTABLE)) {
    resolvedGhPath = process.env.GH_EXECUTABLE;
    return resolvedGhPath;
  }
  const candidates = [
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      resolvedGhPath = candidate;
      return resolvedGhPath;
    }
  }
  resolvedGhPath = "gh";
  return resolvedGhPath;
}

async function runGh(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Test seam: when an executor is injected it fully replaces process
  // invocation so suites can script gh behavior without live GitHub.
  if (ghExecutorOverride) {
    return ghExecutorOverride(args);
  }
  const ghPath = resolveGhPath();
  if (!ghPath) {
    return { stdout: "", stderr: "gh not found", code: 127 };
  }
  return runExecFile(ghPath, args, { timeout: 12_000, windowsHide: true });
}

export type GhExecutor = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

let ghExecutorOverride: GhExecutor | null = null;

/** Test-only injection point for scripted gh behavior. */
export function setGhExecutorForTests(executor: GhExecutor | null): void {
  ghExecutorOverride = executor;
}

export async function getGitHubStatus(): Promise<GitHubStatusDto> {
  try {
    const version = await runGh(GH_OPERATIONS.version);
    const installed =
      version.code === 0 && /gh version/i.test(version.stdout + version.stderr);
    if (!installed) {
      return { installed: false, authenticated: false, accountName: null };
    }

    const auth = await runGh(GH_OPERATIONS.authStatus);
    if (auth.code !== 0) {
      return { installed: true, authenticated: false, accountName: null };
    }

    const user = await runGh(GH_OPERATIONS.user);
    let accountName: string | null = null;
    if (user.code === 0) {
      try {
        const parsed = JSON.parse(user.stdout) as { login?: unknown };
        if (typeof parsed.login === "string" && parsed.login.trim()) {
          accountName = parsed.login.trim();
        }
      } catch {
        accountName = null;
      }
    }
    return { installed: true, authenticated: true, accountName };
  } catch {
    return { installed: false, authenticated: false, accountName: null };
  }
}

export async function fetchGitHubRepoMetadata(
  owner: string,
  repository: string,
): Promise<GitHubMetadataDto | null> {
  if (!isSafeSegment(owner) || !isSafeSegment(repository)) return null;
  try {
    const result = await runGh(["api", `repos/${owner}/${repository}`]);
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout) as {
      owner?: { login?: string };
      name?: string;
      full_name?: string;
      visibility?: string;
      private?: boolean;
      default_branch?: string;
      html_url?: string;
      pushed_at?: string;
    };
    const resolvedOwner =
      (typeof parsed.owner?.login === "string" && parsed.owner.login) || owner;
    const name = (typeof parsed.name === "string" && parsed.name) || repository;
    const htmlUrl =
      typeof parsed.html_url === "string" && parsed.html_url
        ? parsed.html_url
        : `https://github.com/${resolvedOwner}/${name}`;
    const visibility =
      typeof parsed.visibility === "string"
        ? parsed.visibility
        : parsed.private === true
          ? "private"
          : parsed.private === false
            ? "public"
            : null;
    return {
      owner: resolvedOwner,
      name,
      fullName:
        (typeof parsed.full_name === "string" && parsed.full_name) ||
        `${resolvedOwner}/${name}`,
      visibility,
      defaultBranch:
        typeof parsed.default_branch === "string" ? parsed.default_branch : null,
      htmlUrl,
      lastPushedAt: typeof parsed.pushed_at === "string" ? parsed.pushed_at : null,
    };
  } catch {
    return null;
  }
}

export { parseGitHubRemote };

// ---------------------------------------------------------------------------
// V1.1 adapter surface: account repository listing (picker), bounded commit
// fetch, and per-binding refresh. Same discipline as above: frozen argument
// shapes, argv arrays, defensive parsing, failures resolve to typed values
// (never thrown) so GitHub problems can never break local functionality.
// ---------------------------------------------------------------------------

export type PickerRepo = {
  owner: string;
  name: string;
  fullName: string;
  visibility: string | null;
  language: string | null;
  description: string | null;
  archived: boolean;
  fork: boolean;
  /** Whether the authenticated account can push (raw permission bit). */
  viewerCanPush: boolean;
  pushedAt: string | null;
};

type RawPickerRepo = {
  name?: unknown;
  full_name?: unknown;
  owner?: { login?: unknown } | null;
  private?: unknown;
  visibility?: unknown;
  language?: unknown;
  description?: unknown;
  archived?: unknown;
  fork?: unknown;
  permissions?: { push?: unknown };
  pushed_at?: unknown;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * List repositories available to the authenticated account across owner,
 * collaborator, and organization memberships (locked Q2 scope). Bounded:
 * at most PICKER_MAX_PAGES pages. Any failure returns null — the picker
 * then shows a retryable error instead of breaking the page.
 */
export async function listAccountRepositories(): Promise<PickerRepo[] | null> {
  const all: PickerRepo[] = [];
  try {
    for (let page = 1; page <= PICKER_MAX_PAGES; page++) {
      const result = await runGh([
        "api",
        `user/repos?per_page=${PICKER_PER_PAGE}&page=${page}`,
      ]);
      if (result.code !== 0) {
        return all.length > 0 ? all : null; // partial data is still useful
      }
      let parsed: RawPickerRepo[];
      try {
        parsed = JSON.parse(result.stdout) as RawPickerRepo[];
      } catch {
        break;
      }
      if (!Array.isArray(parsed)) break;

      for (const raw of parsed) {
        const name = str(raw.name);
        const owner =
          raw.owner != null && typeof raw.owner === "object"
            ? str((raw.owner as { login?: unknown }).login)
            : null;
        if (!name || !owner || !isSafeSegment(owner) || !isSafeSegment(name)) continue;
        const visibility =
          str(raw.visibility) ??
          (raw.private === true ? "private" : raw.private === false ? "public" : null);
        all.push({
          owner,
          name,
          fullName: str(raw.full_name) ?? `${owner}/${name}`,
          visibility,
          language: str(raw.language),
          description: str(raw.description),
          archived: raw.archived === true,
          fork: raw.fork === true,
          viewerCanPush: raw.permissions?.push === true,
          pushedAt: str(raw.pushed_at),
        });
      }

      if (parsed.length < PICKER_PER_PAGE) break; // exhausted
    }
    return all;
  } catch {
    return all.length > 0 ? all : null;
  }
}

/** Bounded recent commits for one repository (default branch). Null on failure. */
export async function fetchRecentCommits(
  owner: string,
  repository: string,
): Promise<Array<{ sha: string; subject: string | null; authorName: string | null; committedAt: string | null }> | null> {
  if (!isSafeSegment(owner) || !isSafeSegment(repository)) return null;
  try {
    const result = await runGh(["api", `repos/${owner}/${repository}/commits?per_page=100`]);
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout) as Array<{
      sha?: unknown;
      commit?: {
        message?: unknown;
        author?: { name?: unknown; date?: unknown };
      };
    }>;
    if (!Array.isArray(parsed)) return null;
    const commits: Array<{
      sha: string;
      subject: string | null;
      authorName: string | null;
      committedAt: string | null;
    }> = [];
    for (const entry of parsed) {
      if (typeof entry.sha !== "string" || !entry.sha) continue;
      const message = str(entry.commit?.message);
      commits.push({
        sha: entry.sha,
        subject: message ? message.split("\n")[0].slice(0, 200) : null,
        authorName: str(entry.commit?.author?.name),
        committedAt: str(entry.commit?.author?.date),
      });
    }
    return commits;
  } catch {
    return null;
  }
}

export { PICKER_MAX_PAGES };
