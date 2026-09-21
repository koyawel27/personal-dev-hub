import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { GIT_OPERATIONS, isFrozenGitArgv } from "../src/lib/gitRunner.js";
import { fingerprintAnchorLocalBindingId } from "../src/services/ProjectService.js";
import {
  setGhExecutorForTests,
  type GhExecutor,
} from "../src/services/GitHubService.js";
import { createGitRepo, gitExec, makeTempDir, useTempDb, writeFakeGitDir } from "./helpers.js";
import { canonicalizePath } from "../../shared/paths.js";

/**
 * V1.2 M3 — Add Local Copy (owner-directed attachment to an EXISTING
 * project) + shared attachLocalBinding service.
 *
 * Gates under test:
 * - GITHUB ONLY -> first local copy: existing Project reused (no duplicate),
 *   binding primary, LOCAL + GITHUB, metadata + GitHub binding preserved.
 * - Additional copy: attaches non-primary, chosen primary untouched,
 *   fingerprint anchor unchanged, top-level localPath/snapshot unchanged.
 * - Canonical-path rejection: same project (plain already-tracked) and
 *   another project (explicit conflict, binding NEVER moved).
 * - Path validation: PATH_NOT_FOUND / NOT_GIT_REPOSITORY with no DB write.
 * - Evidence model: remote-identity match and SHA overlap are strong
 *   positives (no confirmation); insufficient evidence requires explicit
 *   owner confirmation (LOCAL_BINDING_CONFIRM_REQUIRED) and a strong
 *   identity conflict can NEVER be bypassed by confirmUnverified.
 * - Atomicity: a simulated persistence failure leaves no binding/snapshot/
 *   commit/remote/event residue and the primary invariant valid.
 * - Per-binding rescan/remove reuse the EXISTING safe endpoints; removing
 *   a secondary preserves the primary; files on disk are never touched.
 * - ZERO Git write operations: every process spawned during attach is from
 *   the frozen READ-ONLY operation set.
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
      }
      return actual.runExecFile(file, args, options);
    },
  };
});

const persistenceGuard = vi.hoisted(() => ({ failNext: false }));

vi.mock("../src/services/ActivityService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/ActivityService.js")>();
  return {
    ...actual,
    persistActivityEvents: (
      ...args: Parameters<typeof actual.persistActivityEvents>
    ) => {
      if (persistenceGuard.failNext) {
        persistenceGuard.failNext = false;
        throw new Error("simulated persistence failure");
      }
      return actual.persistActivityEvents(...args);
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
  persistenceGuard.failNext = false;
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

// --- helpers -----------------------------------------------------------------

/**
 * Deterministic SHA separation: createGitRepo's initial commit is identical
 * across fixtures, so tests that must prove SHA-level distinctness (or the
 * absence of overlap) add a uniquely named commit.
 */
async function uniqueCommit(dir: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  await gitExec(dir, ["add", name]);
  await gitExec(dir, ["commit", "-m", name]);
}

async function cloneRepo(source: string): Promise<string> {
  const dir = makeTempDir("ldd-attach-clone-");
  cleanup.push(dir);
  await gitExec(dir, ["clone", source, "."]);
  await gitExec(dir, ["config", "user.email", "dev@example.com"]);
  await gitExec(dir, ["config", "user.name", "Dev"]);
  await gitExec(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function manualAdd(repoPath: string): Promise<{ projectId: number; bindingId: number }> {
  const res = await request(app)
    .post("/api/repositories/manual")
    .send({ path: repoPath })
    .expect(201);
  return {
    projectId: res.body.repository.projectId as number,
    bindingId: res.body.repository.id as number,
  };
}

function attach(projectId: number, body: Record<string, unknown>) {
  return request(app).post(`/api/projects/${projectId}/local-bindings`).send(body);
}

function scalar(query: string, ...params: (string | number)[]): number {
  return (getDb().prepare(query).get(...params) as { n: number }).n;
}

/**
 * The persistence layer stores canonicalizePath(dir) — realpath-resolved, so
 * on hosts with 8.3 short names it can differ textually from the fixture
 * string. Assertions compare against the SAME canonicalization the service
 * applies.
 */
function expectStoredPath(actual: string, rawDir: string): void {
  expect(actual).toBe(canonicalizePath(rawDir));
}

function primaryFlag(id: number): number | undefined {
  const row = getDb()
    .prepare("SELECT is_primary FROM local_repositories WHERE id = ?")
    .get(id) as { is_primary: number } | undefined;
  return row?.is_primary;
}

/** Minimal gh stub: repo metadata only; anything else fails closed. */
function metadataOnlyGhStub(): GhExecutor {
  return async (args) => {
    const argv = args.join(" ");
    const match = /^api repos\/([^/]+)\/([^/]+)$/.exec(argv);
    if (match) {
      return {
        stdout: JSON.stringify({
          owner: { login: match[1] },
          name: match[2],
          full_name: `${match[1]}/${match[2]}`,
          visibility: "public",
          default_branch: "main",
          html_url: `https://github.com/${match[1]}/${match[2]}`,
          pushed_at: "2026-08-01T00:00:00Z",
        }),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: "unexpected", code: 127 };
  };
}

// --- gates 1 + 7: strong positive evidence via matching remote ---------------

describe("first local copy attached to a GITHUB ONLY project", () => {
  it("reuses the existing Project, becomes LOCAL + GITHUB, and preserves metadata and the GitHub binding", async () => {
    setGhExecutorForTests(metadataOnlyGhStub());
    const tracked = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/adopt-first" })
      .expect(201);
    const projectId = tracked.body.projectId as number;
    await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send({ projectStatus: "Active" })
      .expect(200);

    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    await gitExec(repoPath, ["remote", "add", "origin", "https://github.com/octo/adopt-first.git"]);

    const projectsBefore = scalar("SELECT COUNT(*) AS n FROM projects");
    const attached = await attach(projectId, { path: repoPath }).expect(201);

    // Response carries the new binding + the authoritative Project Detail.
    expect(attached.body.binding.isPrimary).toBe(true);
    expectStoredPath(attached.body.binding.localPath, repoPath);
    expect(attached.body.project.id).toBe(projectId);
    expect(attached.body.project.sourceState).toBe("LOCAL + GITHUB");
    expect(attached.body.project.projectStatus).toBe("Active");
    expect(attached.body.project.githubMetadata?.fullName).toBe("octo/adopt-first");

    // Existing Project reused: no duplicate project row was created.
    expect(scalar("SELECT COUNT(*) AS n FROM projects")).toBe(projectsBefore);
    // Exactly one explicit primary for the project.
    expect(
      scalar(
        "SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ? AND is_primary = 1",
        projectId,
      ),
    ).toBe(1);
  });

  it("strong positive evidence via a matching LOCAL binding remote: accepted without confirmation", async () => {
    // Project identity comes from an existing local binding's remote (no
    // tracked GitHub binding involved).
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await gitExec(repoA, ["remote", "add", "origin", "https://github.com/octo/via-local-remote.git"]);
    await uniqueCommit(repoA, "alpha-only.txt");
    const first = await manualAdd(repoA);

    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await gitExec(repoB, ["remote", "add", "origin", "https://github.com/octo/via-local-remote.git"]);
    await uniqueCommit(repoB, "beta-only.txt");

    const attached = await attach(first.projectId, { path: repoB }).expect(201);
    expect(attached.body.binding.isPrimary).toBe(false);
    expectStoredPath(attached.body.binding.localPath, repoB);
    expect(attached.body.project.localBindings).toHaveLength(2);
  });
});

// --- gate 2: additional local copy --------------------------------------------

describe("additional local copy on a project with an existing local binding", () => {
  it("attaches non-primary and leaves the chosen primary, anchor, and top-level primary fields untouched", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "primary-only.txt");
    const first = await manualAdd(repoA);
    const projectId = first.projectId;

    // Owner deliberately selects a NON-minimum-id binding as primary: switch
    // to repoB after attaching it, then attach repoC and prove the choice.
    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await uniqueCommit(repoB, "second-copy.txt");
    const second = await attach(projectId, { path: repoB, confirmUnverified: true }).expect(201);
    const bindingB = second.body.binding.id as number;
    await request(app).post(`/api/repositories/${bindingB}/primary`).expect(200);

    const anchorBefore = fingerprintAnchorLocalBindingId(projectId);
    const detailBefore = await request(app).get(`/api/projects/${projectId}`).expect(200);

    const repoC = await createGitRepo();
    cleanup.push(repoC);
    await uniqueCommit(repoC, "third-copy.txt");
    const third = await attach(projectId, { path: repoC, confirmUnverified: true }).expect(201);
    const bindingC = third.body.binding.id as number;

    // New binding is non-primary; the OWNER-SELECTED primary (B) stays.
    expect(third.body.binding.isPrimary).toBe(false);
    expect(primaryFlag(bindingB)).toBe(1);
    expect(primaryFlag(bindingC)).toBe(0);
    // Server-authoritative order: primary first, then id ASC.
    expect(third.body.project.localBindings.map((b: { id: number }) => b.id)).toEqual([
      bindingB,
      first.bindingId,
      bindingC,
    ]);

    // Fingerprint anchor (MIN(id)) unchanged — no history re-keying.
    expect(fingerprintAnchorLocalBindingId(projectId)).toBe(anchorBefore);
    expect(anchorBefore).toBe(first.bindingId);

    // Top-level primary fields unchanged until the owner changes primary.
    expect(third.body.project.localPath).toBe(detailBefore.body.project.localPath);
    expect(third.body.project.snapshot).toEqual(detailBefore.body.project.snapshot);
  });
});

// --- gates 3 + 4: canonical-path conflicts -------------------------------------

describe("canonical path already tracked", () => {
  it("same project: rejected as already attached, no duplicate binding", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "same-proj.txt");
    const first = await manualAdd(repoA);

    const rejected = await attach(first.projectId, { path: repoA }).expect(400);
    expect(rejected.body.error.code).toBe("REPOSITORY_ALREADY_TRACKED");
    expect(
      scalar(
        "SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ?",
        first.projectId,
      ),
    ).toBe(1);
  });

  it("another project: explicit conflict, binding NOT moved, both projects intact", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "stay-put.txt");
    const first = await manualAdd(repoA);

    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await uniqueCommit(repoB, "other-proj.txt");
    const second = await manualAdd(repoB);

    const rejected = await attach(second.projectId, { path: repoA }).expect(400);
    expect(rejected.body.error.code).toBe("REPOSITORY_ALREADY_TRACKED");
    // The error names the project that already owns the folder.
    expect(rejected.body.error.message).toContain(`project "${path.basename(repoA)}"`);

    // The binding was NOT silently moved; both projects remain intact.
    const owner = getDb()
      .prepare("SELECT project_id FROM local_repositories WHERE id = ?")
      .get(first.bindingId) as { project_id: number };
    expect(owner.project_id).toBe(first.projectId);
    const detailA = await request(app).get(`/api/projects/${first.projectId}`).expect(200);
    const detailB = await request(app).get(`/api/projects/${second.projectId}`).expect(200);
    expect(detailA.body.project.localBindings).toHaveLength(1);
    expect(detailB.body.project.localBindings).toHaveLength(1);
  });
});

// --- gates 5 + 6: path validation with no database write -----------------------

describe("path validation rejects without any database write", () => {
  it("missing path: PATH_NOT_FOUND and no binding row", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    const first = await manualAdd(repoA);

    const before = scalar("SELECT COUNT(*) AS n FROM local_repositories");
    const rejected = await attach(first.projectId, {
      path: "C:\\definitely\\not\\here\\missing-repo",
    });
    expect(rejected.body.error.code).toBe("PATH_NOT_FOUND");
    expect(scalar("SELECT COUNT(*) AS n FROM local_repositories")).toBe(before);
  });

  it("existing folder that is not a Git worktree: NOT_GIT_REPOSITORY and no binding row", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    const first = await manualAdd(repoA);

    const fakeDir = makeTempDir("ldd-attach-fake-");
    cleanup.push(fakeDir);
    writeFakeGitDir(fakeDir);

    const before = scalar("SELECT COUNT(*) AS n FROM local_repositories");
    const rejected = await attach(first.projectId, { path: fakeDir });
    expect(rejected.body.error.code).toBe("NOT_GIT_REPOSITORY");
    expect(scalar("SELECT COUNT(*) AS n FROM local_repositories")).toBe(before);
  });

  it("unknown project id: 404 with no binding row", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "orphan-target.txt");
    const before = scalar("SELECT COUNT(*) AS n FROM local_repositories");
    const rejected = await attach(999999, { path: repoA });
    expect(rejected.body.error.code).toBe("REPOSITORY_NOT_FOUND");
    expect(scalar("SELECT COUNT(*) AS n FROM local_repositories")).toBe(before);
  });
});

// --- gates 8 + 9 + 10: evidence ladder ------------------------------------------

describe("attachment evidence", () => {
  it("strong positive via SHA overlap: accepted without confirmation", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "overlap-anchor.txt");
    const first = await manualAdd(repoA);

    // A clone shares every commit SHA but carries no recognized GitHub
    // remote (origin is a local path) — only SHA overlap can be evidence.
    const copy = await cloneRepo(repoA);

    const attached = await attach(first.projectId, { path: copy }).expect(201);
    expect(attached.body.binding.isPrimary).toBe(false);
    expectStoredPath(attached.body.binding.localPath, copy);
  });

  it("insufficient evidence: LOCAL_BINDING_CONFIRM_REQUIRED first, no insert, confirmed retry succeeds", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "target-history.txt");
    const first = await manualAdd(repoA);

    const repoX = await createGitRepo();
    cleanup.push(repoX);
    await uniqueCommit(repoX, "unrelated-history.txt");

    const firstTry = await attach(first.projectId, { path: repoX });
    expect(firstTry.status).toBe(409);
    expect(firstTry.body.error.code).toBe("LOCAL_BINDING_CONFIRM_REQUIRED");
    // Nothing was inserted by the unconfirmed attempt.
    expect(
      scalar("SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ?", first.projectId),
    ).toBe(1);

    const confirmed = await attach(first.projectId, {
      path: repoX,
      confirmUnverified: true,
    }).expect(201);
    expect(confirmed.body.binding.isPrimary).toBe(false);
    expect(confirmed.body.project.localBindings).toHaveLength(2);
  });

  it("strong identity conflict: rejected and confirmUnverified must NOT bypass it", async () => {
    setGhExecutorForTests(metadataOnlyGhStub());
    const tracked = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/conflict-target" })
      .expect(201);
    const projectId = tracked.body.projectId as number;

    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await gitExec(repoB, ["remote", "add", "origin", "https://github.com/octo/conflict-other.git"]);
    await uniqueCommit(repoB, "conflicting-history.txt");

    const localsBefore = scalar("SELECT COUNT(*) AS n FROM local_repositories");
    const rejected = await attach(projectId, { path: repoB });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("LOCAL_BINDING_IDENTITY_CONFLICT");

    const bypass = await attach(projectId, {
      path: repoB,
      confirmUnverified: true,
    });
    expect(bypass.status).toBe(409);
    expect(bypass.body.error.code).toBe("LOCAL_BINDING_IDENTITY_CONFLICT");

    // Neither attempt mutated anything.
    expect(scalar("SELECT COUNT(*) AS n FROM local_repositories")).toBe(localsBefore);
  });
});

// --- gate 11: atomicity ----------------------------------------------------------

describe("attach atomicity", () => {
  it("simulated persistence failure leaves no binding/snapshot/commit/remote/event residue", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "atomic-anchor.txt");
    const first = await manualAdd(repoA);
    const projectId = first.projectId;

    const repoX = await createGitRepo();
    cleanup.push(repoX);
    await uniqueCommit(repoX, "doomed-copy.txt");

    const localsBefore = scalar("SELECT COUNT(*) AS n FROM local_repositories");
    const snapshotsBefore = scalar("SELECT COUNT(*) AS n FROM repository_snapshots");
    const commitsBefore = scalar("SELECT COUNT(*) AS n FROM commits");
    const remotesBefore = scalar("SELECT COUNT(*) AS n FROM git_remotes");
    const eventsBefore = scalar("SELECT COUNT(*) AS n FROM activity_events WHERE project_id = ?", projectId);

    persistenceGuard.failNext = true;
    const failed = await attach(projectId, { path: repoX, confirmUnverified: true });
    expect(failed.status).toBe(500);

    // Zero residue: no binding, no partial snapshot/commit/remote rows, and
    // the event stream is untouched.
    expect(scalar("SELECT COUNT(*) AS n FROM local_repositories")).toBe(localsBefore);
    expect(scalar("SELECT COUNT(*) AS n FROM repository_snapshots")).toBe(snapshotsBefore);
    expect(scalar("SELECT COUNT(*) AS n FROM commits")).toBe(commitsBefore);
    expect(scalar("SELECT COUNT(*) AS n FROM git_remotes")).toBe(remotesBefore);
    expect(
      scalar("SELECT COUNT(*) AS n FROM activity_events WHERE project_id = ?", projectId),
    ).toBe(eventsBefore);

    // The primary invariant is intact: exactly one explicit primary.
    expect(
      scalar(
        "SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ? AND is_primary = 1",
        projectId,
      ),
    ).toBe(1);

    // The same attach succeeds once the simulated failure is gone.
    await attach(projectId, { path: repoX, confirmUnverified: true }).expect(201);
  });
});

// --- gates 15 + 16: per-binding actions reuse the existing safe endpoints -------

describe("per-binding rescan and remove", () => {
  it("rescan targets the correct binding id and refreshes only that binding's snapshot", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    const first = await manualAdd(repoA);

    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await gitExec(repoB, ["checkout", "-b", "feature"]);
    await uniqueCommit(repoB, "feature-work.txt");
    const second = await attach(first.projectId, { path: repoB, confirmUnverified: true }).expect(201);
    const bindingB = second.body.binding.id as number;

    const refreshed = await request(app)
      .post(`/api/repositories/${bindingB}/refresh`)
      .expect(200);
    expect(refreshed.body.repository.id).toBe(bindingB);

    const detail = await request(app).get(`/api/projects/${first.projectId}`).expect(200);
    const bindings = detail.body.project.localBindings as Array<{
      id: number;
      snapshot: { branch: string } | null;
    }>;
    const rowA = bindings.find((b) => b.id === first.bindingId)!;
    const rowB = bindings.find((b) => b.id === bindingB)!;
    // The refreshed row carries its own branch; the untouched binding keeps
    // its own snapshot (which was already captured at manual-add time).
    expect(rowB.snapshot?.branch).toBe("feature");
    expect(rowA.snapshot?.branch).toBe("main");
  });

  it("removing a secondary binding preserves the primary and never touches files on disk", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "survivor.txt");
    const first = await manualAdd(repoA);

    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await uniqueCommit(repoB, "removed-copy.txt");
    const second = await attach(first.projectId, { path: repoB, confirmUnverified: true }).expect(201);
    const bindingB = second.body.binding.id as number;

    const removed = await request(app).delete(`/api/repositories/${bindingB}`).expect(200);
    expect(removed.body).toEqual({ ok: true, projectDeleted: false });

    expect(primaryFlag(first.bindingId)).toBe(1);
    expect(
      scalar("SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ?", first.projectId),
    ).toBe(1);
    // Files on disk are never deleted — for EITHER copy.
    expect(fs.existsSync(repoA)).toBe(true);
    expect(fs.existsSync(repoB)).toBe(true);
  });
});

// --- gate 20: no Git write operations anywhere in the attach workflow ------------

describe("Add Local Copy Git surface", () => {
  it("every process spawned during attach belongs to the frozen READ-ONLY operation set", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "readonly-anchor.txt");
    const first = await manualAdd(repoA);

    const repoX = await createGitRepo();
    cleanup.push(repoX);
    await uniqueCommit(repoX, "readonly-copy.txt");

    gitSpawnGuard.recording = true;
    try {
      // Full evidence ladder in one recording window: the unverified refusal
      // performs the same inspection as the confirmed retry.
      await attach(first.projectId, { path: repoX });
      await attach(first.projectId, { path: repoX, confirmUnverified: true }).expect(201);
    } finally {
      gitSpawnGuard.recording = false;
    }

    expect(gitSpawnGuard.spawns.length).toBeGreaterThan(0);
    for (const spawn of gitSpawnGuard.spawns) {
      // The runner refuses non-frozen argv outright; this asserts the attach
      // path only ever issued operations from the frozen READ-ONLY set.
      expect(isFrozenGitArgv(spawn.args)).toBe(true);
      expect(Object.values(GIT_OPERATIONS).some((args) => JSON.stringify([...args]) === JSON.stringify(spawn.args))).toBe(true);
    }
  });
});
