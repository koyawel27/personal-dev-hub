export type ParsedGitHubRemote = {
  host: "github.com";
  owner: string;
  repository: string;
  htmlUrl: string;
};

const GITHUB_HTTPS =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH_URL =
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

function cleanRepoName(raw: string): string {
  return raw.replace(/\.git$/i, "").replace(/\/+$/, "");
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

/**
 * Parse a Git remote URL as GitHub without calling `gh`.
 * Non-GitHub and malformed remotes return null.
 */
export function parseGitHubRemote(url: string): ParsedGitHubRemote | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let owner: string | undefined;
  let repo: string | undefined;

  const https = trimmed.match(GITHUB_HTTPS);
  const ssh = trimmed.match(GITHUB_SSH);
  const sshUrl = trimmed.match(GITHUB_SSH_URL);

  if (https) {
    owner = https[1];
    repo = https[2];
  } else if (ssh) {
    owner = ssh[1];
    repo = ssh[2];
  } else if (sshUrl) {
    owner = sshUrl[1];
    repo = sshUrl[2];
  } else {
    return null;
  }

  owner = owner?.trim();
  repo = cleanRepoName(repo ?? "");

  if (!owner || !repo || !isSafeSegment(owner) || !isSafeSegment(repo)) {
    return null;
  }

  return {
    host: "github.com",
    owner,
    repository: repo,
    htmlUrl: `https://github.com/${owner}/${repo}`,
  };
}

export function githubPageUrl(owner: string, repository: string): string {
  return `https://github.com/${owner}/${repository}`;
}
