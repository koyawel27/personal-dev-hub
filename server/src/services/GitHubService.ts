import fs from "node:fs";
import { parseGitHubRemote, isSafeSegment } from "../../../shared/github-remote.js";
import type { GitHubMetadataDto, GitHubStatusDto } from "../../../shared/api-types.js";
import { runExecFile } from "../lib/processRunner.js";

const GH_OPERATIONS = {
  version: ["--version"],
  authStatus: ["auth", "status"],
  user: ["api", "user"],
} as const;

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
  const ghPath = resolveGhPath();
  if (!ghPath) {
    return { stdout: "", stderr: "gh not found", code: 127 };
  }
  return runExecFile(ghPath, args, { timeout: 12_000, windowsHide: true });
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
