import { AppError, ErrorCodes } from "../lib/errors.js";
import { runGit } from "../lib/gitRunner.js";
import {
  parseAheadBehind,
  parseLog,
  parsePorcelain,
  parseRemotes,
  type ParsedCommit,
  type ParsedRemote,
  type WorkingTreeStatus,
} from "../lib/gitParse.js";

export type GitInspection = {
  branch: string | null;
  headCommitSha: string | null;
  workingTree: WorkingTreeStatus;
  remotes: ParsedRemote[];
  upstreamRef: string | null;
  aheadCount: number | null;
  behindCount: number | null;
  recentCommits: ParsedCommit[];
};

async function stdoutOrEmpty(
  operation: Parameters<typeof runGit>[0],
  cwd: string,
): Promise<{ stdout: string; code: number }> {
  const result = await runGit(operation, cwd);
  return { stdout: result.stdout, code: result.code };
}

export async function isRepository(cwd: string): Promise<boolean> {
  try {
    const result = await runGit("isWorkTree", cwd);
    return result.code === 0 && result.stdout.trim() === "true";
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCodes.GIT_UNAVAILABLE) {
      throw err;
    }
    return false;
  }
}

export async function inspectRepository(cwd: string): Promise<GitInspection> {
  const isRepo = await isRepository(cwd);
  if (!isRepo) {
    throw new AppError(
      ErrorCodes.NOT_GIT_REPOSITORY,
      "The selected folder is not a Git repository.",
    );
  }

  const [branchRes, headRes, statusRes, remotesRes, logRes, upstreamRes] =
    await Promise.all([
      stdoutOrEmpty("branch", cwd),
      stdoutOrEmpty("headSha", cwd),
      stdoutOrEmpty("status", cwd),
      stdoutOrEmpty("remotes", cwd),
      stdoutOrEmpty("recentCommits", cwd),
      stdoutOrEmpty("upstream", cwd),
    ]);

  const branchRaw = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  const branch =
    !branchRaw || branchRaw === "HEAD" ? "Detached HEAD" : branchRaw;

  const headCommitSha =
    headRes.code === 0 && /^[0-9a-f]{4,40}$/i.test(headRes.stdout.trim())
      ? headRes.stdout.trim()
      : null;

  const workingTree = parsePorcelain(statusRes.stdout);
  const remotes = parseRemotes(remotesRes.stdout);
  const recentCommits = logRes.code === 0 ? parseLog(logRes.stdout) : [];

  const upstreamRef =
    upstreamRes.code === 0 && upstreamRes.stdout.trim()
      ? upstreamRes.stdout.trim()
      : null;

  let aheadCount: number | null = null;
  let behindCount: number | null = null;
  if (upstreamRef) {
    const aheadRes = await stdoutOrEmpty("aheadBehind", cwd);
    const parsed = parseAheadBehind(aheadRes.stdout);
    if (parsed) {
      aheadCount = parsed.ahead;
      behindCount = parsed.behind;
    }
  }

  return {
    branch,
    headCommitSha,
    workingTree,
    remotes,
    upstreamRef,
    aheadCount,
    behindCount,
    recentCommits,
  };
}
