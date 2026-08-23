import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDb } from "../db/client.js";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { parseGitHubRemote } from "../../../shared/github-remote.js";

export type LauncherAction = "folder" | "terminal" | "vscode" | "github";

type RepoLaunchRow = {
  id: number;
  local_path: string;
  canonical_path: string;
};

function getTrackedRepo(id: number): RepoLaunchRow {
  const row = getDb()
    .prepare(
      "SELECT id, local_path, canonical_path FROM local_repositories WHERE id = ?",
    )
    .get(id) as RepoLaunchRow | undefined;
  if (!row) {
    throw new AppError(
      ErrorCodes.REPOSITORY_NOT_FOUND,
      "Repository was not found.",
      404,
    );
  }
  return row;
}

function spawnDetached(
  file: string,
  args: readonly string[],
  cwd?: string,
): void {
  const child = spawn(file, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd,
  });
  child.unref();
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveVsCode(): string {
  const fromEnv = process.env.VSCODE_EXECUTABLE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const localAppData = process.env.LOCALAPPDATA || "";
  const found = firstExisting([
    path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
    path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
    "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
  ]);
  return found || "code.cmd";
}

function resolveWindowsTerminal(): string | null {
  const localAppData = process.env.LOCALAPPDATA || "";
  return firstExisting([
    "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminalPreview",
    path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe"),
    "C:\\Users\\Default\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
  ]) || (fs.existsSync("C:\\Windows\\System32\\wt.exe") ? "C:\\Windows\\System32\\wt.exe" : "wt.exe");
}

function githubUrlForRepo(id: number): string {
  const remotes = getDb()
    .prepare(
      `SELECT url, is_primary FROM git_remotes
       WHERE local_repository_id = ?
       ORDER BY is_primary DESC, name ASC`,
    )
    .all(id) as { url: string; is_primary: number }[];

  for (const remote of remotes) {
    const parsed = parseGitHubRemote(remote.url);
    if (parsed) return parsed.htmlUrl;
  }
  throw new AppError(
    ErrorCodes.GITHUB_UNAVAILABLE,
    "This repository has no GitHub remote.",
    400,
  );
}

export function launchRepositoryAction(
  repositoryId: number,
  action: LauncherAction,
): { ok: true } {
  const repo = getTrackedRepo(repositoryId);
  const repoPath = repo.local_path;

  // Source-awareness (V1.1): local-only actions require a real checkout;
  // the Open GitHub action is valid for any GitHub-linked repository.
  if (action !== "github") {
    if (!fs.existsSync(repoPath)) {
      throw new AppError(
        ErrorCodes.PATH_NOT_FOUND,
        "The repository folder was not found on disk.",
        404,
      );
    }
  }

  try {
    switch (action) {
      case "folder":
        spawnDetached("explorer.exe", [repoPath]);
        break;
      case "terminal": {
        const wt = resolveWindowsTerminal();
        if (wt && wt !== "wt.exe") {
          spawnDetached(wt, ["-d", repoPath]);
        } else {
          try {
            spawnDetached("wt.exe", ["-d", repoPath]);
          } catch {
            spawnDetached("cmd.exe", ["/k"], repoPath);
          }
        }
        break;
      }
      case "vscode":
        spawnDetached(resolveVsCode(), [repoPath]);
        break;
      case "github":
        spawnDetached("explorer.exe", [githubUrlForRepo(repositoryId)]);
        break;
      default:
        throw new AppError(ErrorCodes.INTERNAL_ERROR, "Unknown launcher action.", 500);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      ErrorCodes.LAUNCHER_FAILED,
      "The requested application could not be opened.",
      500,
    );
  }

  return { ok: true };
}
