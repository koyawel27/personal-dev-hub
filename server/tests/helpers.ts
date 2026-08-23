import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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

/**
 * Build a realistic PRE-V1.1 database (baseline + 002 + 003 applied, no
 * project entity) for migration testing. Returns the db path.
 *
 * Uses raw SQL application rather than openDatabase() so that NO V1.1
 * migration ever sees an empty legacy database: the caller opens the file
 * afterwards via openDatabase()/getDb(), which then runs 004+ against the
 * fully populated pre-V1.1 state — exactly like a real upgrade.
 */
export function createLegacyDb(): string {
  const dir = makeTempDir("ldd-legacy-");
  const dbPath = path.join(dir, "legacy.sqlite");
  process.env.DASHBOARD_DB_PATH = dbPath;
  closeDb();

  const database = new DatabaseSync(dbPath);
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db");
  database.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  database.exec(
    fs.readFileSync(path.join(here, "migrations", "002_project_metadata.sql"), "utf8"),
  );
  database.exec(
    fs.readFileSync(path.join(here, "migrations", "003_app_settings.sql"), "utf8"),
  );
  for (const name of ["001_initial", "002_project_metadata", "003_app_settings"]) {
    database
      .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run(name, "2026-08-20T10:00:00.000Z");
  }

  // Two local repositories with metadata, snapshots, remotes, commits,
  // enrichment cache rows, and activity events — the full pre-V1.1 shape.
  const now = "2026-08-20T10:00:00.000Z";
  const repos: Array<{
    path: string;
    name: string;
    status: string | null;
    type: string | null;
    note: string | null;
    portfolio: number;
    order: number | null;
  }> = [
    { path: "C:\\proj\\alpha", name: "alpha", status: "Active", type: "Personal", note: "core app", portfolio: 1, order: 1 },
    { path: "C:\\proj\\beta", name: "beta", status: null, type: "School", note: null, portfolio: 0, order: null },
  ];
  for (const repo of repos) {
    const result = database
      .prepare(
        `INSERT INTO local_repositories
           (source_id, name, local_path, canonical_path, discovery_type, created_at)
         VALUES (NULL, ?, ?, ?, 'manual', ?)`,
      )
      .run(repo.name, repo.path, repo.path.toLowerCase(), now);
    const id = Number(result.lastInsertRowid);
    database
      .prepare(
        `UPDATE local_repositories SET
           project_status = ?, project_type = ?, project_note = ?,
           include_in_portfolio = ?, portfolio_order = ?
         WHERE id = ?`,
      )
      .run(repo.status, repo.type, repo.note, repo.portfolio, repo.order, id);

    database
      .prepare(
        `INSERT INTO repository_snapshots
           (local_repository_id, branch, head_commit_sha, is_dirty, modified_count,
            staged_count, untracked_count, upstream_ref, ahead_count, behind_count, captured_at)
         VALUES (?, 'main', 'aaa111', 0, 0, 0, 0, NULL, NULL, NULL, ?)`,
      )
      .run(id, now);

    database
      .prepare(
        `INSERT INTO git_remotes
           (local_repository_id, name, url, host, owner, repository_name, github_repository_id, is_primary, last_seen_at)
         VALUES (?, 'origin', ?, 'github.com', 'octocat', ?, NULL, 1, ?)`,
      )
      .run(id, `https://github.com/octocat/${repo.name}.git`, repo.name, now);

    database
      .prepare(
        `INSERT INTO commits
           (local_repository_id, commit_sha, subject, author_name, committed_at, first_seen_at)
         VALUES (?, ?, ?, 'Dev', ?, ?)`,
      )
      .run(id, `sha_${repo.name}_1`, `${repo.name} initial`, now, now);

    database
      .prepare(
        `INSERT INTO activity_events
           (local_repository_id, event_type, summary, occurred_at, source, fingerprint, metadata_json)
         VALUES (?, 'repository_discovered', 'Repository discovered', ?, 'scan', ?, '{}')`,
      )
      .run(id, now, `${id}:repository_discovered`);
    database
      .prepare(
        `INSERT INTO activity_events
           (local_repository_id, event_type, summary, occurred_at, source, fingerprint, metadata_json)
         VALUES (?, 'commit_observed', ?, ?, 'scan', ?, '{}')`,
      )
      .run(id, `${repo.name} initial`, now, `${id}:commit:sha_${repo.name}_1`);
  }

  // Enrichment cache row for alpha (pre-V1.1 shape, untracked). Owner case
  // differs from the remote URL on purpose: norm backfill must lowercase it.
  database
    .prepare(
      `INSERT INTO github_repositories
         (owner, name, full_name, visibility, default_branch, html_url, last_pushed_at, last_refreshed_at)
       VALUES ('OctoCat', 'alpha', 'OctoCat/alpha', 'private', 'main',
               'https://github.com/OctoCat/alpha', '2026-08-19T00:00:00Z', ?)`,
    )
    .run(now);

  database.close();
  return dbPath;
}
