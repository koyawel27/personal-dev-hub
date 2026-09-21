import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  setGhExecutorForTests,
  type GhExecutor,
} from "../src/services/GitHubService.js";
import { createGitRepo, gitExec, makeTempDir, useTempDb, writeFakeGitDir } from "./helpers.js";
import type { LocalBindingHealthDto, ProjectLocalBindingDto } from "../../shared/api-types.js";

/**
 * V1.2 M2 — multi-binding read model + hybrid health.
 *
 * Contract under test:
 * - GET /api/projects/:id exposes EVERY local binding (display primary
 *   first, then id ASC), each with its OWN latest snapshot and OWN health;
 *   top-level localPath/snapshot keep describing ONLY the display primary
 *   (a non-primary dirty worktree or branch never leaks upward).
 * - Project Detail local commits union ALL bindings, deduplicated at read
 *   time on Project + lower(sha) BEFORE the 20-row limit; the representative
 *   row prefers the effective display-primary observation, then lowest
 *   binding id — never repository name/order.
 * - Health precedence: live PATH_MISSING (derived, never persisted) >
 *   UNSCANNED (derived) > cached OK / NOT_A_GIT_REPO (persisted only by
 *   explicit inspection).
 * - Explicit refresh honesty: missing path -> PATH_NOT_FOUND (no Git spawn);
 *   present non-Git directory -> NOT_A_GIT_REPO persisted + existing
 *   NOT_GIT_REPOSITORY error, historical snapshot untouched.
 * - ZERO Git processes for ordinary list/detail/dashboard/portfolio renders
 *   (process runner guarded during render windows below).
 */

const gitSpawnGuard = vi.hoisted(() => ({
  recording: false,
  spawns: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock("../src/lib/processRunner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/processRunner.js")>();
  return {
    ...actual,
    runExecFile: async (
      file: string,
      args: readonly string[],
      options?: { cwd?: string; timeout?: number; windowsHide?: boolean },
    ) => {
      if (gitSpawnGuard.recording) {
        gitSpawnGuard.spawns.push({ file, args: [...args] });
        return { stdout: "", stderr: "blocked: renders must not spawn processes", code: 1 };
      }
      return actual.runExecFile(file, args, options);
    },
  };
});

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
});

afterEach(() => {
  gitSpawnGuard.recording = false;
  gitSpawnGuard.spawns = [];
  setGhExecutorForTests(null);
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// --- seeds (binding rows only; snapshots/health come from real Git flows) ----

function seedProject(name: string): number {
  const now = new Date().toISOString();
  return Number(
    getDb()
      .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
      .run(name, now, now).lastInsertRowid,
  );
}

function seedBinding(
  projectId: number,
  localPath: string,
  options: { isPrimary?: boolean } = {},
): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO local_repositories
           (source_id, project_id, is_primary, name, local_path, canonical_path, discovery_type, created_at)
         VALUES (NULL, ?, ?, ?, ?, ?, 'manual', ?)`,
      )
      .run(
        projectId,
        options.isPrimary ? 1 : 0,
        path.basename(localPath),
        localPath,
        localPath.toLowerCase(),
        new Date().toISOString(),
      ).lastInsertRowid,
  );
}

function seedCommit(
  bindingId: number,
  sha: string,
  subject: string,
  committedAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO commits (local_repository_id, commit_sha, subject, author_name, committed_at, first_seen_at)
       VALUES (?, ?, ?, 'Dev', ?, ?)`,
    )
    .run(bindingId, sha, subject, committedAt, committedAt);
}

function seedSnapshot(
  bindingId: number,
  capturedAt: string,
  options: { branch?: string; isDirty?: boolean } = {},
): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO repository_snapshots
           (local_repository_id, branch, head_commit_sha, is_dirty, modified_count,
            staged_count, untracked_count, upstream_ref, ahead_count, behind_count, captured_at)
         VALUES (?, ?, NULL, ?, 0, 0, 0, NULL, NULL, NULL, ?)`,
      )
      .run(bindingId, options.branch ?? "main", options.isDirty ? 1 : 0, capturedAt)
      .lastInsertRowid,
  );
}

function bindingRow(id: number): {
  last_health_state: string | null;
  last_health_checked_at: string | null;
  last_scanned_at: string | null;
} {
  return (
    getDb()
      .prepare(
        "SELECT last_health_state, last_health_checked_at, last_scanned_at FROM local_repositories WHERE id = ?",
      )
      .get(id) as {
      last_health_state: string | null;
      last_health_checked_at: string | null;
      last_scanned_at: string | null;
    }
  );
}

type DetailBody = {
  project: {
    id: number;
    localPath: string | null;
    snapshot: { branch: string | null; isDirty: boolean; capturedAt: string } | null;
    localBindings: ProjectLocalBindingDto[];
    commits: Array<{ sha: string; shortSha: string; subject: string; source: string }>;
  };
};

async function getDetail(projectId: number): Promise<DetailBody["project"]> {
  const res = await request(app).get(`/api/projects/${projectId}`).expect(200);
  return (res.body as DetailBody).project;
}

async function cloneRepo(source: string): Promise<string> {
  const dir = makeTempDir("ldd-clone-");
  cleanup.push(dir);
  await gitExec(dir, ["clone", source, "."]);
  await gitExec(dir, ["config", "user.email", "dev@example.com"]);
  await gitExec(dir, ["config", "user.name", "Dev"]);
  await gitExec(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function commitFile(dir: string, file: string, message: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  await gitExec(dir, ["add", file]);
  await gitExec(dir, ["commit", "-m", message]);
}

// --- read model: bindings, snapshots, primary semantics ----------------------

describe("project detail multi-binding read model", () => {
  it("two local copies, same SHA: both bindings listed, exactly one primary, shared SHA exposed once", async () => {
    const source = await createGitRepo();
    cleanup.push(source);
    const copy = await cloneRepo(source);

    const projectId = seedProject("same-sha-fixture");
    const bindingA = seedBinding(projectId, source, { isPrimary: true });
    const bindingB = seedBinding(projectId, copy);

    await request(app).post(`/api/repositories/${bindingA}/refresh`).expect(200);
    await request(app).post(`/api/repositories/${bindingB}/refresh`).expect(200);

    // Storage really does hold the same SHA under BOTH bindings.
    const stored = getDb()
      .prepare("SELECT COUNT(DISTINCT local_repository_id) AS n FROM commits")
      .get() as { n: number };
    expect(stored.n).toBe(2);

    const project = await getDetail(projectId);
    expect(project.localBindings).toHaveLength(2);
    expect(project.localBindings.map((binding) => binding.id)).toEqual([bindingA, bindingB]);
    expect(project.localBindings.filter((binding) => binding.isPrimary)).toHaveLength(1);
    expect(project.localBindings[0]!.isPrimary).toBe(true);
    expect(project.localBindings[1]!.isPrimary).toBe(false);
    // Each binding carries its own health from its own explicit inspection.
    for (const binding of project.localBindings) {
      expect(binding.health.state).toBe("OK");
      expect(binding.health.checkedAt).not.toBeNull();
    }

    // The shared SHA appears ONCE in Project Detail commits.
    const shas = project.commits.map((commit) => commit.sha.toLowerCase());
    expect(new Set(shas).size).toBe(shas.length);
    expect(shas).toHaveLength(1);
    for (const commit of project.commits) {
      expect(commit.source).toBe("local");
    }
  });

  it("two local copies, divergent SHAs: all logical commits appear once, ordering deterministic, top-level fields stay primary-only", async () => {
    const source = await createGitRepo();
    cleanup.push(source);
    const copy = await cloneRepo(source);
    await commitFile(copy, "copy-only.txt", "copy-only divergence");
    await commitFile(source, "primary-only.txt", "primary-only divergence");

    const projectId = seedProject("divergent-fixture");
    const bindingA = seedBinding(projectId, source, { isPrimary: true });
    const bindingB = seedBinding(projectId, copy);
    await request(app).post(`/api/repositories/${bindingA}/refresh`).expect(200);
    await request(app).post(`/api/repositories/${bindingB}/refresh`).expect(200);

    const project = await getDetail(projectId);

    // Three logical commits (initial shared + two divergent), each once.
    const subjects = project.commits.map((commit) => commit.subject);
    expect(subjects).toHaveLength(3);
    expect(new Set(project.commits.map((commit) => commit.sha.toLowerCase())).size).toBe(3);
    expect(subjects).toContain("copy-only divergence");
    expect(subjects).toContain("primary-only divergence");
    // Newest first: the initial commit (oldest) renders last.
    expect(subjects[2]).toBe("initial");
    // Deterministic across reads.
    const again = await getDetail(projectId);
    expect(again.commits.map((commit) => commit.sha)).toEqual(
      project.commits.map((commit) => commit.sha),
    );

    // Top-level legacy fields describe ONLY the display primary.
    expect(project.localPath).toBe(source);
    expect(project.snapshot?.branch).toBe("main");
    expect(project.snapshot?.isDirty).toBe(false);
  });

  it("duplicate SHA representative follows the display-primary observation, then MIN(id)", async () => {
    const projectId = seedProject("representative-fixture");
    const a = seedBinding(projectId, "C:/tmp/rep-a", { isPrimary: true });
    const b = seedBinding(projectId, "C:/tmp/rep-b");
    const sha = "a".repeat(40);
    const stamp = "2026-08-01T10:00:00.000Z";
    seedCommit(a, sha, "from-primary", stamp);
    seedCommit(b, sha, "from-secondary", stamp);

    const withPrimaryA = await getDetail(projectId);
    expect(withPrimaryA.commits.map((commit) => commit.subject)).toEqual(["from-primary"]);

    // Primary switch re-keys the representative to the new primary's row.
    await request(app).post(`/api/repositories/${b}/primary`).expect(200);
    const withPrimaryB = await getDetail(projectId);
    expect(withPrimaryB.commits.map((commit) => commit.subject)).toEqual(["from-secondary"]);

    // Zero-explicit-primary repair state: MIN(id) (binding a) represents.
    getDb().prepare("UPDATE local_repositories SET is_primary = 0 WHERE project_id = ?").run(projectId);
    const repaired = await getDetail(projectId);
    expect(repaired.commits.map((commit) => commit.subject)).toEqual(["from-primary"]);
  });

  it("per-binding snapshots stay independent of the display primary", async () => {
    const source = await createGitRepo();
    cleanup.push(source);
    const copy = await cloneRepo(source);
    await gitExec(copy, ["checkout", "-b", "feature"]);
    fs.appendFileSync(path.join(copy, "README.md"), "dirty\n");

    const projectId = seedProject("snapshot-ownership-fixture");
    const bindingA = seedBinding(projectId, source, { isPrimary: true });
    const bindingB = seedBinding(projectId, copy);
    await request(app).post(`/api/repositories/${bindingA}/refresh`).expect(200);
    await request(app).post(`/api/repositories/${bindingB}/refresh`).expect(200);

    const before = await getDetail(projectId);
    expect(before.localPath).toBe(source);
    expect(before.snapshot?.branch).toBe("main");
    expect(before.snapshot?.isDirty).toBe(false);
    const bindingSnapshotA = before.localBindings.find((b) => b.id === bindingA)!.snapshot!;
    const bindingSnapshotB = before.localBindings.find((b) => b.id === bindingB)!.snapshot!;
    expect(bindingSnapshotA.branch).toBe("main");
    expect(bindingSnapshotA.isDirty).toBe(false);
    expect(bindingSnapshotB.branch).toBe("feature");
    expect(bindingSnapshotB.isDirty).toBe(true);

    // Switch the display primary: top-level follows B, binding rows unchanged.
    await request(app).post(`/api/repositories/${bindingB}/primary`).expect(200);
    const after = await getDetail(projectId);
    expect(after.localPath).toBe(copy);
    expect(after.snapshot?.branch).toBe("feature");
    expect(after.snapshot?.isDirty).toBe(true);
    expect(after.localBindings.map((b) => b.id)).toEqual([bindingB, bindingA]);
    expect(after.localBindings.find((b) => b.id === bindingA)!.snapshot).toEqual(bindingSnapshotA);
    expect(after.localBindings.find((b) => b.id === bindingB)!.snapshot).toEqual(bindingSnapshotB);
  });
});

// --- latest-snapshot rule (pre-M2 Project Detail contract) -------------------

describe("project detail latest-snapshot selection", () => {
  it("captured_at is authoritative even when a restored row carries a higher id with an older captured_at", async () => {
    const projectId = seedProject("snapshot-order-fixture");
    const bindingA = seedBinding(projectId, "C:/tmp/snap-order-a", { isPrimary: true });

    // Snapshot A FIRST with the NEWER captured_at...
    const snapshotA = seedSnapshot(bindingA, "2026-09-01T12:00:00.000Z", {
      branch: "newer-captured",
    });
    // ...snapshot B SECOND: higher database id, OLDER captured_at.
    const snapshotB = seedSnapshot(bindingA, "2026-08-01T12:00:00.000Z", {
      branch: "older-captured",
    });
    expect(snapshotB).toBeGreaterThan(snapshotA);

    const project = await getDetail(projectId);
    // Both the binding row and the Project top level follow captured_at.
    expect(project.localBindings[0]!.snapshot!.branch).toBe("newer-captured");
    expect(project.localBindings[0]!.snapshot!.capturedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(project.snapshot!.branch).toBe("newer-captured");
    expect(project.snapshot!.capturedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("breaks captured_at ties by higher id", async () => {
    const projectId = seedProject("snapshot-tie-fixture");
    const bindingA = seedBinding(projectId, "C:/tmp/snap-tie-a", { isPrimary: true });

    seedSnapshot(bindingA, "2026-09-01T12:00:00.000Z", { branch: "tie-older-id" });
    seedSnapshot(bindingA, "2026-09-01T12:00:00.000Z", { branch: "tie-higher-id" });

    const project = await getDetail(projectId);
    expect(project.localBindings[0]!.snapshot!.branch).toBe("tie-higher-id");
    expect(project.snapshot!.branch).toBe("tie-higher-id");
  });
});

// --- hybrid health -----------------------------------------------------------

describe("local binding health", () => {
  it("UNSCANNED: existing path without cached health derives UNSCANNED with no Git process", async () => {
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    const projectId = seedProject("unscanned-fixture");
    seedBinding(projectId, repoPath, { isPrimary: true });

    gitSpawnGuard.recording = true;
    const project = await getDetail(projectId);
    expect(project.localBindings[0]!.health).toEqual({
      state: "UNSCANNED",
      checkedAt: null,
    });
    expect(gitSpawnGuard.spawns).toHaveLength(0);
  });

  it("OK: explicit inspection persists OK + checkedAt; later reads return it cached without Git", async () => {
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    const created = await request(app)
      .post("/api/repositories/manual")
      .send({ path: repoPath })
      .expect(201);
    const bindingId = created.body.repository.id as number;
    expect(bindingRow(bindingId).last_health_state).toBe("OK");
    expect(bindingRow(bindingId).last_health_checked_at).not.toBeNull();

    gitSpawnGuard.recording = true;
    const project = await getDetail(created.body.repository.projectId as number);
    expect(project.localBindings[0]!.health.state).toBe("OK");
    expect(project.localBindings[0]!.health.checkedAt).toBe(
      bindingRow(bindingId).last_health_checked_at,
    );
    expect(gitSpawnGuard.spawns).toHaveLength(0);
  });

  it("PATH_MISSING: render derives it live, never rewrites the cached verdict, spawns no Git", async () => {
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    const created = await request(app)
      .post("/api/repositories/manual")
      .send({ path: repoPath })
      .expect(201);
    const bindingId = created.body.repository.id as number;
    const cachedBefore = bindingRow(bindingId);

    fs.rmSync(repoPath, { recursive: true, force: true });

    gitSpawnGuard.recording = true;
    const project = await getDetail(created.body.repository.projectId as number);
    expect(project.localBindings[0]!.health).toEqual({
      state: "PATH_MISSING",
      checkedAt: null,
    });
    // List renders also derive PATH_MISSING without Git...
    const listed = await request(app).get("/api/repositories").expect(200);
    expect(listed.status).toBe(200);
    // ...and the database cached health is NOT rewritten by the render.
    expect(bindingRow(bindingId)).toEqual(cachedBefore);
    expect(gitSpawnGuard.spawns).toHaveLength(0);
  });

  it("refresh on a missing tracked path returns PATH_NOT_FOUND without spawning Git", async () => {
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    const created = await request(app)
      .post("/api/repositories/manual")
      .send({ path: repoPath })
      .expect(201);
    const bindingId = created.body.repository.id as number;
    fs.rmSync(repoPath, { recursive: true, force: true });

    gitSpawnGuard.recording = true;
    const refreshed = await request(app)
      .post(`/api/repositories/${bindingId}/refresh`)
      .expect(404);
    expect(refreshed.body.error.code).toBe("PATH_NOT_FOUND");
    expect(refreshed.body.error.code).not.toBe("NOT_GIT_REPOSITORY");
    // The existence check already failed, so Git must not have been spawned.
    expect(gitSpawnGuard.spawns).toHaveLength(0);
    // The failed refresh does not rewrite cached health.
    expect(bindingRow(bindingId).last_health_state).toBe("OK");
  });

  it("NOT_A_GIT_REPO: explicit refresh persists the failed verdict and keeps the historical snapshot", async () => {
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    const created = await request(app)
      .post("/api/repositories/manual")
      .send({ path: repoPath })
      .expect(201);
    const bindingId = created.body.repository.id as number;
    const before = bindingRow(bindingId);
    const snapshotCount = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?")
        .get(bindingId) as { n: number }
    ).n;

    // Same path now exists but is no longer a Git worktree.
    fs.rmSync(repoPath, { recursive: true, force: true });
    writeFakeGitDir(repoPath);

    const refreshed = await request(app)
      .post(`/api/repositories/${bindingId}/refresh`)
      .expect(400);
    expect(refreshed.body.error.code).toBe("NOT_GIT_REPOSITORY");

    const after = bindingRow(bindingId);
    expect(after.last_health_state).toBe("NOT_A_GIT_REPO");
    expect(after.last_health_checked_at).not.toBeNull();
    // last_scanned_at and the historical snapshot are untouched.
    expect(after.last_scanned_at).toBe(before.last_scanned_at);
    expect(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?")
          .get(bindingId) as { n: number }
      ).n,
    ).toBe(snapshotCount);

    // Later ordinary renders return the cached verdict with zero Git spawn.
    gitSpawnGuard.recording = true;
    const project = await getDetail(created.body.repository.projectId as number);
    expect(project.localBindings[0]!.health.state).toBe("NOT_A_GIT_REPO");
    expect(project.localBindings[0]!.health.checkedAt).toBe(after.last_health_checked_at);
    expect(gitSpawnGuard.spawns).toHaveLength(0);
  });

  it("render sweep: many bindings/projects render from SQLite + fs only — zero Git processes", async () => {
    // Distinct real paths per binding (canonical_path is UNIQUE); primaries
    // are never scanned here (UNSCANNED) while several ghosts never existed
    // (PATH_MISSING) — the sweep renders every state family at once.
    for (let i = 0; i < 3; i += 1) {
      const repoPath = await createGitRepo();
      cleanup.push(repoPath);
      const projectId = seedProject(`sweep-${i}`);
      seedBinding(projectId, repoPath, { isPrimary: true });
      seedBinding(projectId, `C:\\tmp\\sweep-ghost-${i}`);
    }
    getDb().prepare("UPDATE projects SET include_in_portfolio = 1 WHERE name = 'sweep-0'").run();

    // One more project whose only binding vanished after a successful scan.
    const vanished = await createGitRepo();
    cleanup.push(vanished);
    const missingProject = seedProject("sweep-missing");
    const missingBinding = seedBinding(missingProject, vanished, { isPrimary: true });
    await request(app).post(`/api/repositories/${missingBinding}/refresh`).expect(200);
    fs.rmSync(vanished, { recursive: true, force: true });

    gitSpawnGuard.recording = true;
    await request(app).get("/api/repositories").expect(200);
    await request(app).get("/api/projects").expect(200);
    await request(app).get("/api/dashboard").expect(200);
    await request(app).get("/api/portfolio").expect(200);
    const projectRows = getDb().prepare("SELECT id FROM projects ORDER BY id ASC").all() as Array<{ id: number }>;
    expect(projectRows.length).toBeGreaterThanOrEqual(4);
    for (const row of projectRows) {
      await request(app).get(`/api/projects/${row.id}`).expect(200);
    }
    // Missing path still derives live even though a cached verdict exists.
    const detail = await request(app).get(`/api/projects/${missingProject}`).expect(200);
    expect(
      (detail.body as DetailBody).project.localBindings[0]!.health.state,
    ).toBe("PATH_MISSING");
    expect(gitSpawnGuard.spawns).toHaveLength(0);
  });
});

// --- untouched neighbors ------------------------------------------------------

describe("M2 does not disturb neighboring contracts", () => {
  it("GITHUB ONLY project detail keeps cached github commits and an empty localBindings array", async () => {
    const ghStub: GhExecutor = async (args) => {
      const argv = args.join(" ");
      if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
        return {
          stdout: JSON.stringify({
            owner: { login: "octo" },
            name: "m2-github-only",
            full_name: "octo/m2-github-only",
            visibility: "public",
            default_branch: "main",
            html_url: "https://github.com/octo/m2-github-only",
            pushed_at: "2026-08-01T00:00:00Z",
          }),
          stderr: "",
          code: 0,
        };
      }
      if (/^api repos\/.+\/commits/.test(argv)) {
        return {
          stdout: JSON.stringify([
            {
              sha: "f".repeat(40),
              commit: { message: "github-side commit", author: { name: "O", date: "2026-08-02T00:00:00Z" } },
            },
          ]),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
    };
    setGhExecutorForTests(ghStub);

    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/m2-github-only" })
      .expect(201);
    const project = await getDetail(track.body.projectId as number);
    expect(project.localBindings).toEqual([]);
    expect(project.snapshot).toBeNull();
    expect(project.localPath).toBeNull();
    expect(project.commits).toHaveLength(1);
    expect(project.commits[0]!.source).toBe("github");
  });

  it("binding health never derives from Git when the project row is gone from the list", async () => {
    // Health DTO shape guard: derived states carry no checkedAt even when a
    // stale cached verdict exists underneath (precedence check).
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    const projectId = seedProject("precedence-fixture");
    const bindingId = seedBinding(projectId, repoPath, { isPrimary: true });
    getDb()
      .prepare(
        "UPDATE local_repositories SET last_health_state = 'OK', last_health_checked_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), bindingId);
    fs.rmSync(repoPath, { recursive: true, force: true });

    gitSpawnGuard.recording = true;
    const project = await getDetail(projectId);
    const health: LocalBindingHealthDto = project.localBindings[0]!.health;
    // Current truth (path gone) overrides the cached OK.
    expect(health.state).toBe("PATH_MISSING");
    expect(health.checkedAt).toBeNull();
    expect(gitSpawnGuard.spawns).toHaveLength(0);
  });
});
