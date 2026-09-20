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
import { createGitRepo, gitExec, makeTempDir, useTempDb } from "./helpers.js";
import { canonicalizePath } from "../../shared/paths.js";

/**
 * V1.2 M4 — Safe Relink / Moved-Path Recovery (owner-directed re-pointing of
 * an EXISTING local binding to a moved/renamed folder).
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

// --- helpers -----------------------------------------------------------------

/** Deterministic SHA separation across fixtures. */
async function uniqueCommit(dir: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  await gitExec(dir, ["add", name]);
  await gitExec(dir, ["commit", "-m", name]);
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

function relink(bindingId: number, body: Record<string, unknown>) {
  return request(app).post(`/api/repositories/${bindingId}/relink`).send(body);
}

function scalar(query: string, ...params: (string | number)[]): number {
  return (getDb().prepare(query).get(...params) as { n: number }).n;
}

function expectStoredPath(actual: string, rawDir: string): void {
  expect(actual).toBe(canonicalizePath(rawDir));
}

function bindingRow(id: number) {
  return getDb()
    .prepare(
      `SELECT id, project_id, is_primary, name, local_path, canonical_path,
              discovery_type, source_id, created_at, last_health_state,
              last_health_checked_at, last_scanned_at
       FROM local_repositories WHERE id = ?`,
    )
    .get(id) as {
    id: number;
    project_id: number | null;
    is_primary: number;
    name: string;
    local_path: string;
    canonical_path: string;
    discovery_type: string;
    source_id: number | null;
    created_at: string;
    last_health_state: string | null;
    last_health_checked_at: string | null;
    last_scanned_at: string | null;
  };
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

// --- gate 1: strong match via recognized remote identity ---------------------

describe("Relink strong match", () => {
  it("relinks with matching recognized remote identity, preserving binding identity and history", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await gitExec(repoOld, ["remote", "add", "origin", "https://github.com/octo/moved.git"]);
    await uniqueCommit(repoOld, "old-only.txt");
    const { projectId, bindingId } = await manualAdd(repoOld);
    const before = bindingRow(bindingId);
    const snapshotsBefore = scalar(
      "SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?",
      bindingId,
    );
    const anchorBefore = fingerprintAnchorLocalBindingId(projectId);

    // Same repository moved to a new folder (clone shares remote identity).
    const repoNew = makeTempDir("ldd-relink-");
    cleanup.push(repoNew);
    await gitExec(repoNew, ["clone", repoOld, "."]);
    await gitExec(repoNew, ["config", "user.email", "dev@example.com"]);
    await gitExec(repoNew, ["config", "user.name", "Dev"]);
    await gitExec(repoNew, ["remote", "set-url", "origin", "https://github.com/octo/moved.git"]);

    const res = await relink(bindingId, { path: repoNew }).expect(200);
    expect(res.body.binding.id).toBe(bindingId);
    expectStoredPath(res.body.binding.localPath, repoNew);
    expect(res.body.project.id).toBe(projectId);
    expect(res.body.binding.health.state).toBe("OK");

    const after = bindingRow(bindingId);
    // Identity preservation (gate 12).
    expect(after.id).toBe(before.id);
    expect(after.project_id).toBe(before.project_id);
    expect(after.is_primary).toBe(before.is_primary);
    expect(after.created_at).toBe(before.created_at);
    expect(after.source_id).toBe(before.source_id);
    expect(after.discovery_type).toBe(before.discovery_type);
    // Path + derived name updated.
    expectStoredPath(after.local_path, repoNew);
    expect(after.canonical_path).toBe(canonicalizePath(repoNew).toLowerCase());
    // History preserved and appended (gate 13): old snapshots remain.
    expect(
      scalar(
        "SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?",
        bindingId,
      ),
    ).toBeGreaterThan(snapshotsBefore);
    // Fingerprint anchor unchanged (gate 14).
    expect(fingerprintAnchorLocalBindingId(projectId)).toBe(anchorBefore);
    // Health cache updated to OK (gate M4-M).
    expect(after.last_health_state).toBe("OK");
  });

  it("gate 2 + 3: ONE overlapping SHA is sufficient even when remote identities differ", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await gitExec(repoOld, ["remote", "add", "origin", "https://github.com/octo/old-remote.git"]);
    const { bindingId } = await manualAdd(repoOld);
    // Old binding's stored commits include the initial + this unique commit.
    await uniqueCommit(repoOld, "shared-history.txt");
    await request(app).post(`/api/repositories/${bindingId}/refresh`).expect(200);

    // Candidate is a clone (shares commit SHAs) but pointed at a DIFFERENT
    // remote identity — so only SHA overlap is the positive evidence.
    const repoNew = makeTempDir("ldd-relink-sha-");
    cleanup.push(repoNew);
    await gitExec(repoNew, ["clone", repoOld, "."]);
    await gitExec(repoNew, ["remote", "set-url", "origin", "https://github.com/other/different-remote.git"]);

    // No confirmation required: single SHA overlap is a strong positive.
    const res = await relink(bindingId, { path: repoNew }).expect(200);
    expect(res.body.binding.id).toBe(bindingId);
    expectStoredPath(res.body.binding.localPath, repoNew);
  });
});

// --- gates 4 + 5: insufficient evidence -------------------------------------

describe("Relink insufficient evidence", () => {
  it("gate 4: first request returns confirmation-required with NO mutation", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await uniqueCommit(repoOld, "unrelated-old.txt");
    const { bindingId } = await manualAdd(repoOld);
    const before = bindingRow(bindingId);
    const snapsBefore = scalar(
      "SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?",
      bindingId,
    );

    const repoNew = await createGitRepo();
    cleanup.push(repoNew);
    await uniqueCommit(repoNew, "unrelated-new.txt"); // no SHA overlap

    const res = await relink(bindingId, { path: repoNew }).expect(409);
    expect(res.body.error.code).toBe("LOCAL_BINDING_RELINK_CONFIRM_REQUIRED");
    expect(res.body.error.message).toContain("insufficient evidence");

    const after = bindingRow(bindingId);
    expect(after.local_path).toBe(before.local_path);
    expect(after.canonical_path).toBe(before.canonical_path);
    expect(after.last_scanned_at).toBe(before.last_scanned_at);
    expect(
      scalar(
        "SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?",
        bindingId,
      ),
    ).toBe(snapsBefore);
  });

  it("gate 5: confirmed retry with literal true succeeds", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await uniqueCommit(repoOld, "unrelated-old.txt");
    const { bindingId } = await manualAdd(repoOld);
    const repoNew = await createGitRepo();
    cleanup.push(repoNew);
    await uniqueCommit(repoNew, "unrelated-new.txt");

    const res = await relink(bindingId, { path: repoNew, confirmUnverified: true }).expect(200);
    expect(res.body.binding.id).toBe(bindingId);
    expectStoredPath(res.body.binding.localPath, repoNew);
  });

  it("confirmation gate only accepts literal true (non-boolean does not bypass)", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await uniqueCommit(repoOld, "unrelated-old.txt");
    const { bindingId } = await manualAdd(repoOld);
    const repoNew = await createGitRepo();
    cleanup.push(repoNew);
    await uniqueCommit(repoNew, "unrelated-new.txt");

    await relink(bindingId, { path: repoNew, confirmUnverified: "yes" }).expect(409);
    await relink(bindingId, { path: repoNew, confirmUnverified: 1 }).expect(409);
  });
});

// --- gate 6: strong identity mismatch ----------------------------------------

describe("Relink strong identity mismatch", () => {
  it("hard rejection; confirmUnverified=true cannot bypass; binding unchanged", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await gitExec(repoOld, ["remote", "add", "origin", "https://github.com/octo/old-repo.git"]);
    await uniqueCommit(repoOld, "old-history.txt");
    const { bindingId } = await manualAdd(repoOld);
    const before = bindingRow(bindingId);

    const repoNew = await createGitRepo();
    cleanup.push(repoNew);
    await gitExec(repoNew, ["remote", "add", "origin", "https://github.com/other/new-repo.git"]);
    await uniqueCommit(repoNew, "new-history.txt");

    const first = await relink(bindingId, { path: repoNew }).expect(409);
    expect(first.body.error.code).toBe("LOCAL_BINDING_RELINK_IDENTITY_CONFLICT");
    expect(first.body.error.message).toContain("octo/old-repo");
    expect(first.body.error.message).toContain("other/new-repo");
    expect(first.body.error.message).toContain("not changed");

    const second = await relink(bindingId, { path: repoNew, confirmUnverified: true }).expect(409);
    expect(second.body.error.code).toBe("LOCAL_BINDING_RELINK_IDENTITY_CONFLICT");

    const after = bindingRow(bindingId);
    expect(after.local_path).toBe(before.local_path);
    expect(after.canonical_path).toBe(before.canonical_path);
  });
});

// --- gates 7 + 8: path validation --------------------------------------------

describe("Relink path validation", () => {
  it("gate 7: missing candidate path -> PATH_NOT_FOUND, no mutation", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    const { bindingId } = await manualAdd(repoOld);
    const before = bindingRow(bindingId);
    const missing = path.join(makeTempDir("ldd-gone-"), "no-such-dir");

    const res = await relink(bindingId, { path: missing }).expect(400);
    expect(res.body.error.code).toBe("PATH_NOT_FOUND");
    expect(bindingRow(bindingId).local_path).toBe(before.local_path);
  });

  it("gate 8: existing folder but not Git -> NOT_GIT_REPOSITORY, old binding untouched", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    const { bindingId } = await manualAdd(repoOld);
    const before = bindingRow(bindingId);

    const notGit = makeTempDir("ldd-notgit-");
    cleanup.push(notGit);

    const res = await relink(bindingId, { path: notGit }).expect(400);
    expect(res.body.error.code).toBe("NOT_GIT_REPOSITORY");
    const after = bindingRow(bindingId);
    expect(after.local_path).toBe(before.local_path);
    // The invalid candidate must NOT persist NOT_A_GIT_REPO onto the old binding.
    expect(after.last_health_state).toBe(before.last_health_state);
  });
});

// --- gates 9 + 10 + 11: canonical-path conflicts -----------------------------

describe("Relink canonical-path conflicts", () => {
  it("gate 9: candidate already tracked by another binding in the SAME Project", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "a.txt");
    const { projectId, bindingId: bindingA } = await manualAdd(repoA);

    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await gitExec(repoB, ["remote", "add", "origin", "https://github.com/octo/same-proj.git"]);
    await uniqueCommit(repoB, "b.txt");
    const attachRes = await request(app)
      .post(`/api/projects/${projectId}/local-bindings`)
      .send({ path: repoB, confirmUnverified: true })
      .expect(201);
    const bindingB = attachRes.body.binding.id as number;

    const res = await relink(bindingA, { path: repoB }).expect(400);
    expect(res.body.error.code).toBe("REPOSITORY_ALREADY_TRACKED");
    expect(bindingRow(bindingA).canonical_path).toBe(canonicalizePath(repoA).toLowerCase());
    expect(bindingRow(bindingB).canonical_path).toBe(canonicalizePath(repoB).toLowerCase());
    expect(scalar("SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ?", projectId)).toBe(2);
  });

  it("gate 10: candidate already tracked by a binding in ANOTHER Project", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await uniqueCommit(repoA, "a.txt");
    const { bindingId: bindingA, projectId: projectA } = await manualAdd(repoA);

    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await uniqueCommit(repoB, "b.txt");
    const { bindingId: bindingB, projectId: projectB } = await manualAdd(repoB);

    const res = await relink(bindingA, { path: repoB }).expect(400);
    expect(res.body.error.code).toBe("REPOSITORY_ALREADY_TRACKED");
    expect(bindingRow(bindingA).project_id).toBe(projectA);
    expect(bindingRow(bindingA).canonical_path).toBe(canonicalizePath(repoA).toLowerCase());
    expect(bindingRow(bindingB).project_id).toBe(projectB);
    expect(bindingRow(bindingB).canonical_path).toBe(canonicalizePath(repoB).toLowerCase());
  });

  it("gate 11: candidate equals this binding's current path -> use Rescan, no fake history", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await uniqueCommit(repoOld, "a.txt");
    const { bindingId } = await manualAdd(repoOld);
    const snapsBefore = scalar(
      "SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?",
      bindingId,
    );

    const res = await relink(bindingId, { path: repoOld }).expect(400);
    expect(res.body.error.code).toBe("REPOSITORY_ALREADY_TRACKED");
    expect(res.body.error.message).toContain("Use Rescan");
    expect(
      scalar(
        "SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?",
        bindingId,
      ),
    ).toBe(snapsBefore);
  });
});

// --- gate 15: PRIMARY binding Relink -----------------------------------------

describe("Relink primary vs secondary", () => {
  it("gate 15: relinking the PRIMARY binding moves top-level localPath/snapshot, keeps primary flag", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await gitExec(repoA, ["remote", "add", "origin", "https://github.com/octo/primary-moved.git"]);
    const { projectId, bindingId } = await manualAdd(repoA);
    expect(bindingRow(bindingId).is_primary).toBe(1);

    const repoNew = makeTempDir("ldd-relink-primary-");
    cleanup.push(repoNew);
    await gitExec(repoNew, ["clone", repoA, "."]);
    await gitExec(repoNew, ["remote", "set-url", "origin", "https://github.com/octo/primary-moved.git"]);

    const res = await relink(bindingId, { path: repoNew }).expect(200);
    // Same binding id remains primary.
    expect(res.body.binding.id).toBe(bindingId);
    expect(res.body.binding.isPrimary).toBe(true);
    // Project top-level localPath/snapshot follow the new inspection.
    expectStoredPath(res.body.project.localPath!, repoNew);
    expect(res.body.project.snapshot?.branch).toBe(res.body.binding.snapshot?.branch);
    expect(bindingRow(bindingId).is_primary).toBe(1);
    const detail = await request(app).get(`/api/projects/${projectId}`).expect(200);
    expectStoredPath(detail.body.project.localPath, repoNew);
  });

  it("gate 16: relinking a SECONDARY binding leaves the display primary and top-level fields untouched", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await gitExec(repoA, ["remote", "add", "origin", "https://github.com/octo/shared-remote.git"]);
    await uniqueCommit(repoA, "primary.txt");
    const { projectId, bindingId: primaryId } = await manualAdd(repoA);
    const primaryPath = bindingRow(primaryId).local_path;

    // Secondary binding sharing the remote identity.
    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await gitExec(repoB, ["remote", "add", "origin", "https://github.com/octo/shared-remote.git"]);
    await uniqueCommit(repoB, "secondary.txt");
    const attachRes = await request(app)
      .post(`/api/projects/${projectId}/local-bindings`)
      .send({ path: repoB })
      .expect(201);
    const secondaryId = attachRes.body.binding.id as number;
    expect(attachRes.body.binding.isPrimary).toBe(false);

    // Relink the SECONDARY to a moved folder.
    const repoB2 = makeTempDir("ldd-relink-secondary-");
    cleanup.push(repoB2);
    await gitExec(repoB2, ["clone", repoB, "."]);
    await gitExec(repoB2, ["remote", "set-url", "origin", "https://github.com/octo/shared-remote.git"]);

    const res = await relink(secondaryId, { path: repoB2 }).expect(200);
    expect(res.body.binding.id).toBe(secondaryId);
    expect(res.body.binding.isPrimary).toBe(false);
    expectStoredPath(res.body.binding.localPath, repoB2);

    // Primary binding and top-level Project fields remain those of the primary.
    expect(bindingRow(primaryId).is_primary).toBe(1);
    expectStoredPath(res.body.project.localPath!, primaryPath);
    const detail = await request(app).get(`/api/projects/${projectId}`).expect(200);
    expectStoredPath(detail.body.project.localPath, primaryPath);
    const primaryBinding = (detail.body.project.localBindings as Array<{ id: number; isPrimary: boolean; localPath: string }>)
      .find((b) => b.isPrimary)!;
    expect(primaryBinding.id).toBe(primaryId);
  });

  it("regression: Relink preserves a stored all-zero is_primary state exactly; MIN(id) remains the display primary via the M1 fallback", async () => {
    const repoA = await createGitRepo();
    cleanup.push(repoA);
    await gitExec(repoA, ["remote", "add", "origin", "https://github.com/octo/zero-primary.git"]);
    await uniqueCommit(repoA, "primary.txt");
    const { projectId, bindingId: minId } = await manualAdd(repoA);
    expect(bindingRow(minId).is_primary).toBe(1);

    // Second binding in the SAME Project (shared remote identity).
    const repoB = await createGitRepo();
    cleanup.push(repoB);
    await gitExec(repoB, ["remote", "add", "origin", "https://github.com/octo/zero-primary.git"]);
    await uniqueCommit(repoB, "secondary.txt");
    const attachRes = await request(app)
      .post(`/api/projects/${projectId}/local-bindings`)
      .send({ path: repoB })
      .expect(201);
    const otherId = attachRes.body.binding.id as number;
    expect(otherId).toBeGreaterThan(minId); // The relink target is MIN(id).

    // Directly place BOTH bindings in the stored is_primary=0 state.
    getDb()
      .prepare("UPDATE local_repositories SET is_primary = 0 WHERE project_id = ?")
      .run(projectId);
    expect(bindingRow(minId).is_primary).toBe(0);
    expect(bindingRow(otherId).is_primary).toBe(0);

    // Relink the MIN(id) binding to its moved folder.
    const repoNew = makeTempDir("ldd-relink-zero-primary-");
    cleanup.push(repoNew);
    await gitExec(repoNew, ["clone", repoA, "."]);
    await gitExec(repoNew, ["remote", "set-url", "origin", "https://github.com/octo/zero-primary.git"]);

    const res = await relink(minId, { path: repoNew }).expect(200);

    // Relink must preserve the stored is_primary value EXACTLY: no silent
    // repair may flip an all-zero store back to one explicit primary.
    expect(bindingRow(minId).is_primary).toBe(0);
    expect(bindingRow(otherId).is_primary).toBe(0);
    expect(
      scalar(
        "SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ? AND is_primary = 1",
        projectId,
      ),
    ).toBe(0);

    // Path / snapshot / health updated normally for the relinked binding.
    expect(res.body.binding.id).toBe(minId);
    expectStoredPath(res.body.binding.localPath, repoNew);
    expect(res.body.binding.health.state).toBe("OK");
    expect(res.body.binding.snapshot).not.toBeNull();
    expect(bindingRow(minId).last_health_state).toBe("OK");

    // Server Project Detail still exposes MIN(id) as the effective display
    // primary through the existing M1 fallback (is_primary DESC, id ASC).
    expect(res.body.project.localBindings[0].id).toBe(minId);
    expect(res.body.project.localBindings[0].isPrimary).toBe(true);
    expect(res.body.project.localBindings[1].isPrimary).toBe(false);
    expectStoredPath(res.body.project.localPath!, repoNew);

    const detail = await request(app).get(`/api/projects/${projectId}`).expect(200);
    expect(detail.body.project.localBindings[0].id).toBe(minId);
    expect(detail.body.project.localBindings[0].isPrimary).toBe(true);
    expectStoredPath(detail.body.project.localPath, repoNew);
  });
});

// --- gate 17: PATH_MISSING recovery ------------------------------------------

describe("Relink PATH_MISSING recovery", () => {
  it("old folder removed -> PATH_MISSING; successful Relink reports OK at the new path with the same binding id", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await gitExec(repoOld, ["remote", "add", "origin", "https://github.com/octo/recover.git"]);
    await uniqueCommit(repoOld, "recover.txt");
    const { projectId, bindingId } = await manualAdd(repoOld);

    // Prepare the moved copy BEFORE removing the original (clone preserves identity).
    const repoNew = makeTempDir("ldd-relink-recover-");
    cleanup.push(repoNew);
    await gitExec(repoNew, ["clone", repoOld, "."]);
    await gitExec(repoNew, ["remote", "set-url", "origin", "https://github.com/octo/recover.git"]);

    // Remove the original folder: the binding now reports PATH_MISSING.
    fs.rmSync(repoOld, { recursive: true, force: true });
    cleanup.splice(cleanup.indexOf(repoOld), 1);
    const missing = await request(app).get(`/api/projects/${projectId}`).expect(200);
    const missingRow = (missing.body.project.localBindings as Array<{ id: number; health: { state: string } }>)
      .find((b) => b.id === bindingId)!;
    expect(missingRow.health.state).toBe("PATH_MISSING");

    // Relink to the surviving copy: same binding id reports OK.
    const res = await relink(bindingId, { path: repoNew }).expect(200);
    expect(res.body.binding.id).toBe(bindingId);
    expect(res.body.binding.health.state).toBe("OK");
    expectStoredPath(res.body.binding.localPath, repoNew);

    const detail = await request(app).get(`/api/projects/${projectId}`).expect(200);
    const okRow = (detail.body.project.localBindings as Array<{ id: number; health: { state: string } }>)
      .find((b) => b.id === bindingId)!;
    expect(okRow.health.state).toBe("OK");
  });
});

// --- gate 18: atomicity --------------------------------------------------------

describe("Relink atomicity", () => {
  it("a simulated late persistence failure rolls back the path change and leaves no partial new inspection state", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await gitExec(repoOld, ["remote", "add", "origin", "https://github.com/octo/atomic.git"]);
    await uniqueCommit(repoOld, "atomic.txt");
    const { projectId, bindingId } = await manualAdd(repoOld);
    const before = bindingRow(bindingId);
    const snapsBefore = scalar(
      "SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?",
      bindingId,
    );
    const commitsBefore = scalar(
      "SELECT COUNT(*) AS n FROM commits WHERE local_repository_id = ?",
      bindingId,
    );

    const repoNew = makeTempDir("ldd-relink-atomic-");
    cleanup.push(repoNew);
    await gitExec(repoNew, ["clone", repoOld, "."]);
    await gitExec(repoNew, ["remote", "set-url", "origin", "https://github.com/octo/atomic.git"]);
    await uniqueCommit(repoNew, "atomic-new.txt");

    persistenceGuard.failNext = true;
    await relink(bindingId, { path: repoNew, confirmUnverified: true }).expect(500);

    // Path/canonical rolled back; no partial new snapshot/commit/remote/health.
    const after = bindingRow(bindingId);
    expect(after.local_path).toBe(before.local_path);
    expect(after.canonical_path).toBe(before.canonical_path);
    expect(after.last_health_state).toBe(before.last_health_state);
    expect(after.last_scanned_at).toBe(before.last_scanned_at);
    expect(
      scalar("SELECT COUNT(*) AS n FROM repository_snapshots WHERE local_repository_id = ?", bindingId),
    ).toBe(snapsBefore);
    expect(
      scalar("SELECT COUNT(*) AS n FROM commits WHERE local_repository_id = ?", bindingId),
    ).toBe(commitsBefore);
    expect(
      scalar("SELECT COUNT(*) AS n FROM git_remotes WHERE local_repository_id = ?", bindingId),
    ).toBe(1);
    expect(bindingRow(bindingId).is_primary).toBe(1);
    expect(fingerprintAnchorLocalBindingId(projectId)).toBe(bindingId);

    // A clean retry succeeds after the simulated failure.
    const res = await relink(bindingId, { path: repoNew, confirmUnverified: true }).expect(200);
    expectStoredPath(res.body.binding.localPath, repoNew);
  });
});

// --- gate 19: remote github_repository_id stale-cache hardening ---------------

describe("Relink remote-cache hardening", () => {
  it("same remote NAME with a CHANGED URL clears the stale github_repository_id (no URL-A cache attached to URL B)", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    await gitExec(repoOld, ["remote", "add", "origin", "https://github.com/octo/repo-a.git"]);
    await uniqueCommit(repoOld, "shared.txt");
    const { bindingId } = await manualAdd(repoOld);

    // Seed a github_repositories cache row for repo A and link the remote to it.
    const db = getDb();
    db.prepare(
      `INSERT INTO github_repositories
         (owner, name, full_name, owner_norm, name_norm, html_url)
       VALUES ('octo', 'repo-a', 'octo/repo-a', 'octo', 'repo-a', 'https://github.com/octo/repo-a')`,
    ).run();
    const ghA = (db.prepare("SELECT id FROM github_repositories WHERE owner_norm='octo' AND name_norm='repo-a'").get() as { id: number }).id;
    db.prepare(
      "UPDATE git_remotes SET github_repository_id = ? WHERE local_repository_id = ? AND name = 'origin'",
    ).run(ghA, bindingId);
    const cachedBefore = db
      .prepare("SELECT github_repository_id AS g FROM git_remotes WHERE local_repository_id = ? AND name = 'origin'")
      .get(bindingId) as { g: number | null };
    expect(cachedBefore.g).toBe(ghA);

    // Candidate is a clone (SHA overlap -> strong positive) whose origin now
    // points to repo B. Enrichment is unavailable (no gh stub), so it fails
    // closed and must NOT leave repo A's cache attached to repo B's URL.
    const repoNew = makeTempDir("ldd-relink-cache-");
    cleanup.push(repoNew);
    await gitExec(repoNew, ["clone", repoOld, "."]);
    await gitExec(repoNew, ["remote", "set-url", "origin", "https://github.com/octo/repo-b.git"]);

    await relink(bindingId, { path: repoNew }).expect(200);

    const cachedAfter = db
      .prepare("SELECT url, github_repository_id AS g FROM git_remotes WHERE local_repository_id = ? AND name = 'origin'")
      .get(bindingId) as { url: string; g: number | null };
    expect(cachedAfter.url).toBe("https://github.com/octo/repo-b.git");
    // The stale association to repo A was invalidated by the URL change.
    expect(cachedAfter.g).toBeNull();
  });
});

// --- gate 20: no Git write operations anywhere in the relink workflow ---------

describe("Relink Git surface", () => {
  it("every process spawned during relink belongs to the frozen READ-ONLY operation set", async () => {
    const repoOld = await createGitRepo();
    cleanup.push(repoOld);
    // No recognized remote: evidence stays UNVERIFIED across the ladder.
    await uniqueCommit(repoOld, "ro-anchor.txt");
    const { bindingId } = await manualAdd(repoOld);

    const repoNew = await createGitRepo();
    cleanup.push(repoNew);
    await uniqueCommit(repoNew, "ro-new.txt");

    gitSpawnGuard.recording = true;
    try {
      // Record across the full evidence ladder: the unverified refusal performs
      // the same read-only inspection as the confirmed retry.
      await relink(bindingId, { path: repoNew });
      await relink(bindingId, { path: repoNew, confirmUnverified: true }).expect(200);
    } finally {
      gitSpawnGuard.recording = false;
    }

    expect(gitSpawnGuard.spawns.length).toBeGreaterThan(0);
    for (const spawn of gitSpawnGuard.spawns) {
      expect(isFrozenGitArgv(spawn.args)).toBe(true);
      expect(
        Object.values(GIT_OPERATIONS).some(
          (args) => JSON.stringify([...args]) === JSON.stringify(spawn.args),
        ),
      ).toBe(true);
    }
  });
});

