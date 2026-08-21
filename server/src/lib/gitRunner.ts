import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { AppError, ErrorCodes } from "./errors.js";
import { runExecFile } from "./processRunner.js";

export const GIT_OPERATIONS = {
  isWorkTree: ["rev-parse", "--is-inside-work-tree"],
  branch: ["rev-parse", "--abbrev-ref", "HEAD"],
  headSha: ["rev-parse", "HEAD"],
  status: ["status", "--porcelain=v1", "-uall"],
  recentCommits: [
    "log",
    "-n",
    "20",
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI",
  ],
  remotes: ["remote", "-v"],
  upstream: [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ],
  aheadBehind: ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
} as const;

export type GitOperation = keyof typeof GIT_OPERATIONS;

function argvKey(args: readonly string[]): string {
  return JSON.stringify([...args]);
}

const FROZEN_ARGV = new Set(
  Object.values(GIT_OPERATIONS).map((args) => argvKey(args)),
);

export function isFrozenGitArgv(args: readonly string[]): boolean {
  return FROZEN_ARGV.has(argvKey(args));
}

let resolvedGitPath: string | null | undefined;

export function resolveGitPath(): string | null {
  if (resolvedGitPath !== undefined) return resolvedGitPath;
  if (process.env.GIT_EXECUTABLE && fs.existsSync(process.env.GIT_EXECUTABLE)) {
    resolvedGitPath = process.env.GIT_EXECUTABLE;
    return resolvedGitPath;
  }
  const candidates = [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      resolvedGitPath = candidate;
      return resolvedGitPath;
    }
  }
  resolvedGitPath = "git";
  return resolvedGitPath;
}

export function resetGitPathCache(): void {
  resolvedGitPath = undefined;
}

/**
 * Spawn Git for a named frozen operation only.
 * There is no public API that accepts caller-built argument arrays.
 */
export async function runGit(
  operation: GitOperation,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const args = GIT_OPERATIONS[operation];
  if (!isFrozenGitArgv(args)) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      "Refusing to run a non-frozen Git argument list.",
      500,
    );
  }

  const gitPath = resolveGitPath();
  if (!gitPath) {
    throw new AppError(
      ErrorCodes.GIT_UNAVAILABLE,
      "The system Git executable was not found.",
      503,
    );
  }

  const resolvedCwd = path.resolve(cwd);
  const result = await runExecFile(gitPath, args, {
    cwd: resolvedCwd,
    timeout: config.gitTimeoutMs,
    windowsHide: true,
  });

  if (result.code !== 0 && result.stderr.toLowerCase().includes("not recognized")) {
    throw new AppError(
      ErrorCodes.GIT_UNAVAILABLE,
      "The system Git executable was not found.",
      503,
    );
  }

  return result;
}

export async function gitIsAvailable(): Promise<boolean> {
  try {
    const gitPath = resolveGitPath();
    if (!gitPath) return false;
    const result = await runExecFile(gitPath, ["--version"], {
      timeout: 5000,
      windowsHide: true,
    });
    return result.code === 0 && result.stdout.toLowerCase().includes("git version");
  } catch {
    return false;
  }
}
