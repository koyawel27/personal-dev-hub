import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb } from "../src/db/client.js";
import { resolveGitPath } from "../src/lib/gitRunner.js";
import { runExecFile } from "../src/lib/processRunner.js";

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function useTempDb(): string {
  const dir = makeTempDir("ldd-db-");
  const dbPath = path.join(dir, "test.sqlite");
  process.env.DASHBOARD_DB_PATH = dbPath;
  closeDb();
  return dbPath;
}

export async function gitExec(cwd: string, args: string[]): Promise<void> {
  const git = resolveGitPath();
  if (!git) throw new Error("Git is not available for tests.");
  const result = await runExecFile(git, args, { cwd, timeout: 20_000 });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

export async function createGitRepo(options?: {
  dirty?: boolean;
  untracked?: boolean;
  staged?: boolean;
}): Promise<string> {
  const dir = makeTempDir("ldd-repo-");
  await gitExec(dir, ["init", "-b", "main"]);
  await gitExec(dir, ["config", "user.email", "dev@example.com"]);
  await gitExec(dir, ["config", "user.name", "Dev"]);
  await gitExec(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  await gitExec(dir, ["add", "README.md"]);
  await gitExec(dir, ["commit", "-m", "initial"]);

  if (options?.dirty) {
    fs.appendFileSync(path.join(dir, "README.md"), "dirty\n");
  }
  if (options?.staged) {
    fs.writeFileSync(path.join(dir, "staged.txt"), "staged\n");
    await gitExec(dir, ["add", "staged.txt"]);
  }
  if (options?.untracked) {
    fs.writeFileSync(path.join(dir, "loose.txt"), "untracked\n");
  }
  return dir;
}

export function writeFakeGitDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}
