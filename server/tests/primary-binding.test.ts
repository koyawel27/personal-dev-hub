import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { ensureSinglePrimary } from "../src/services/ProjectService.js";
import {
  setGhExecutorForTests,
  type GhExecutor,
} from "../src/services/GitHubService.js";
import { createGitRepo, gitExec, useTempDb } from "./helpers.js";

/**
 * V1.2 M1 primary-binding invariants (owner decisions D1/D2):
 * - POST /api/repositories/:id/primary is a pure preference flip: exactly
 *   one is_primary=1 per project afterwards, NO development Activity event,
 *   and the MIN(id) fingerprint anchor is untouched.
 * - Removing the primary binding promotes MIN(id) of the survivors in the
 *   same transaction; removing a non-primary leaves the primary untouched.
 * - The defensive backstop (ensureSinglePrimary) restores MIN(id) as
 *   primary for manual/partial states with no explicit primary.
 * - Server-authoritative reads: listRepositories marks exactly one binding
 *   per project; project detail localPath follows the display primary.
 * - Zero-explicit-primary repair states surface MIN(id) as the effective
 *   server primary DTO (clients never derive a primary themselves).
 * - Reverse-adoption merges (reconcileTrackedIdentity) never let the
 *   incoming (newest) binding override the target's chosen primary or its
 *   deterministic MIN(id) fallback.
 * - The primary-switch response exposes NO internal fingerprint anchor;
 *   anchor stability is asserted through stored Activity rows instead.
 * - New standalone bindings become primary through the REAL manual creation
 *   path, not SQL fixtures.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// --- direct seeds (deterministic shapes that do not depend on git) ----------

function seedProject(name: string): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
    .run(name, now, now);
  return Number(result.lastInsertRowid);
}

function seedLocalBinding(projectId: number, localPath: string): number {
  const result = getDb()
    .prepare(
      `INSERT INTO local_repositories
         (source_id, project_id, name, local_path, canonical_path, discovery_type, created_at)
       VALUES (NULL, ?, ?, ?, ?, 'manual', ?)`,
    )
    .run(
      projectId,
      path.basename(localPath),
      localPath,
      localPath.toLowerCase(),
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

function primaryFlag(id: number): number | undefined {
  const row = getDb()
    .prepare("SELECT is_primary FROM local_repositories WHERE id = ?")
    .get(id) as { is_primary: number } | undefined;
  return row?.is_primary;
}

function activityEventCount(projectId: number): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE project_id = ?")
      .get(projectId) as { n: number }
  ).n;
}

function storedFingerprints(projectId: number): string[] {
  return (
    getDb()
      .prepare("SELECT fingerprint FROM activity_events WHERE project_id = ?")
      .all(projectId) as Array<{ fingerprint: string }>
  ).map((row) => row.fingerprint);
}

describe("display-primary switch API (POST /api/repositories/:id/primary)", () => {
  it("flips the primary, exposes no internal fingerprint anchor, and emits no activity event", async () => {
    const projectId = seedProject("switch-fixture");
    const a = seedLocalBinding(projectId, "C:/tmp/switch-a");
    const b = seedLocalBinding(projectId, "C:/tmp/switch-b");
    const c = seedLocalBinding(projectId, "C:/tmp/switch-c");
    await request(app).post(`/api/repositories/${a}/primary`).expect(200);

    const before = activityEventCount(projectId);
    const switched = await request(app).post(`/api/repositories/${c}/primary`).expect(200);
    // The fingerprint anchor is internal persistence identity (D1) and is
    // deliberately NOT part of the API surface.
    expect(switched.body).toEqual({
      ok: true,
      projectId,
      primaryRepositoryId: c,
    });

    expect(primaryFlag(a)).toBe(0);
    expect(primaryFlag(b)).toBe(0);
    expect(primaryFlag(c)).toBe(1);
    expect(activityEventCount(projectId)).toBe(before);
  });

  it("keeps the MIN(id) fingerprint anchor stable: a repeated null->Active transition creates no new Activity row", async () => {
    // Real fingerprint-stability regression (D1): the anchor is NOT asserted
    // through an API echo but through stored Activity behavior. The project
    // status fingerprint must keep scoping through the permanent MIN(id)
    // anchor (binding a), never the mutable display primary — otherwise the
    // second null->Active transition would insert another Activity row
    // against a re-keyed fingerprint.
    const projectId = seedProject("anchor-stability-fixture");
    const a = seedLocalBinding(projectId, "C:/tmp/anchor-a"); // MIN(id) anchor
    const b = seedLocalBinding(projectId, "C:/tmp/anchor-b");
    await request(app).post(`/api/repositories/${a}/primary`).expect(200);

    const setStatus = (status: string | null) =>
      request(app)
        .patch(`/api/projects/${projectId}/metadata`)
        .send({ projectStatus: status })
        .expect(200);

    await setStatus("Active"); // null -> Active
    await setStatus(null); // Active -> null
    const rowsBeforeSwitch = activityEventCount(projectId);
    expect(rowsBeforeSwitch).toBe(2);
    for (const fingerprint of storedFingerprints(projectId)) {
      expect(fingerprint.startsWith(`p${projectId}:${a}:`)).toBe(true);
    }

    await request(app).post(`/api/repositories/${b}/primary`).expect(200); // switch A -> B
    await setStatus("Active"); // null -> Active AGAIN

    // No third row: the repeated transition dedups against the first one
    // because the fingerprint still scopes through the same MIN(id) anchor.
    expect(activityEventCount(projectId)).toBe(rowsBeforeSwitch);
    for (const fingerprint of storedFingerprints(projectId)) {
      expect(fingerprint.startsWith(`p${projectId}:${a}:`)).toBe(true);
    }
  });

  it("is idempotent when the target is already the primary", async () => {
    const projectId = seedProject("idempotent-fixture");
    const a = seedLocalBinding(projectId, "C:/tmp/idem-a");
    await request(app).post(`/api/repositories/${a}/primary`).expect(200);
    const again = await request(app).post(`/api/repositories/${a}/primary`).expect(200);
    expect(again.body).toEqual({
      ok: true,
      projectId,
      primaryRepositoryId: a,
    });
    expect(primaryFlag(a)).toBe(1);
  });

  it("rejects unknown bindings and orphan bindings with the right error codes", async () => {
    const holder = seedProject("orphan-holder-fixture");
    const orphan = seedLocalBinding(holder, "C:/tmp/orphan-binding");
    await getDb()
      .prepare("UPDATE local_repositories SET project_id = NULL WHERE id = ?")
      .run(orphan);

    const missing = await request(app).post("/api/repositories/999999/primary");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("REPOSITORY_NOT_FOUND");

    const noProject = await request(app).post(`/api/repositories/${orphan}/primary`);
    expect(noProject.status).toBe(400);
    expect(noProject.body.error.code).toBe("INVALID_REQUEST");
  });
});

describe("primary removal reassignment (owner decision D2)", () => {
  it("promotes MIN(id) of the survivors in the same transaction", async () => {
    const projectId = seedProject("removal-fixture");
    const a = seedLocalBinding(projectId, "C:/tmp/remove-a");
    const b = seedLocalBinding(projectId, "C:/tmp/remove-b");
    const c = seedLocalBinding(projectId, "C:/tmp/remove-c");
    await request(app).post(`/api/repositories/${a}/primary`).expect(200);

    const removed = await request(app).delete(`/api/repositories/${a}`).expect(200);
    expect(removed.body).toEqual({ ok: true, projectDeleted: false });

    expect(primaryFlag(a)).toBeUndefined(); // row gone
    expect(primaryFlag(b)).toBe(1); // MIN(id) survivor promoted
    expect(primaryFlag(c)).toBe(0);
  });

  it("leaves the primary untouched when a non-primary binding is removed", async () => {
    const projectId = seedProject("nonprimary-removal-fixture");
    const a = seedLocalBinding(projectId, "C:/tmp/keep-a");
    const b = seedLocalBinding(projectId, "C:/tmp/keep-b");
    await request(app).post(`/api/repositories/${a}/primary`).expect(200);

    await request(app).delete(`/api/repositories/${b}`).expect(200);
    expect(primaryFlag(a)).toBe(1);
  });
});

describe("server-authoritative primary reads", () => {
  it("listRepositories marks exactly one primary per project", async () => {
    const projectId = seedProject("read-fixture");
    const a = seedLocalBinding(projectId, "C:/tmp/read-a");
    const b = seedLocalBinding(projectId, "C:/tmp/read-b");
    await request(app).post(`/api/repositories/${b}/primary`).expect(200);

    const listed = await request(app).get("/api/repositories").expect(200);
    const mine = (listed.body.repositories as Array<{ id: number; isPrimary: boolean }>).filter(
      (repo) => repo.id === a || repo.id === b,
    );
    expect(mine.find((repo) => repo.id === b)?.isPrimary).toBe(true);
    expect(mine.find((repo) => repo.id === a)?.isPrimary).toBe(false);
  });

  it("project detail localPath follows the display primary, not id order", async () => {
    const projectId = seedProject("detail-fixture");
    seedLocalBinding(projectId, "C:/tmp/detail-a");
    const b = seedLocalBinding(projectId, "C:/tmp/detail-b");
    await request(app).post(`/api/repositories/${b}/primary`).expect(200);

    const detail = await request(app).get(`/api/projects/${projectId}`).expect(200);
    expect(detail.body.project.localPath).toBe("C:/tmp/detail-b");
  });
});

describe("ensureSinglePrimary backstop (defensive repair)", () => {
  it("restores MIN(id) as primary when no explicit primary exists", () => {
    const projectId = seedProject("backstop-fixture");
    const a = seedLocalBinding(projectId, "C:/tmp/backstop-a");
    const b = seedLocalBinding(projectId, "C:/tmp/backstop-b");
    expect(primaryFlag(a)).toBe(0); // direct seed starts with none explicit

    ensureSinglePrimary(projectId);
    expect(primaryFlag(a)).toBe(1);
    expect(primaryFlag(b)).toBe(0);

    // No-op when the invariant already holds.
    ensureSinglePrimary(projectId);
    expect(primaryFlag(a)).toBe(1);
  });
});

describe("zero-explicit-primary server DTO (MIN(id) effective primary)", () => {
  it("marks exactly MIN(id) as isPrimary for a deliberately zero-primary multi-binding project", async () => {
    const projectId = seedProject("zero-primary-fixture");
    // Adversarial naming: the MIN(id) binding sorts LAST by repository name.
    const a = seedLocalBinding(projectId, "C:/tmp/zero-omega");
    seedLocalBinding(projectId, "C:/tmp/zero-alpha");
    seedLocalBinding(projectId, "C:/tmp/zero-mid");
    // Deliberate zero-explicit-primary repair state (no is_primary=1 row).
    getDb()
      .prepare("UPDATE local_repositories SET is_primary = 0 WHERE project_id = ?")
      .run(projectId);

    const listed = await request(app).get("/api/repositories").expect(200);
    const mine = (
      listed.body.repositories as Array<{
        id: number;
        projectId: number | null;
        name: string;
        isPrimary: boolean;
      }>
    ).filter((repo) => repo.projectId === projectId);
    // Name ordering must not influence primary resolution: exactly MIN(id)
    // carries the effective server primary, everyone else is non-primary.
    expect(mine.filter((repo) => repo.isPrimary).map((repo) => repo.id)).toEqual([a]);
    expect(mine.filter((repo) => !repo.isPrimary)).toHaveLength(2);
  });
});

describe("reverse-adoption primary ownership (reconcileTrackedIdentity)", () => {
  /** Minimal fake gh: repo metadata only; anything else fails closed. */
  const ghStub: GhExecutor = async (args) => {
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

  /** Real manual path: local repo with a GitHub remote, fresh project. */
  async function addLocalWithRemote(
    remoteUrl: string,
  ): Promise<{ projectId: number; bindingId: number }> {
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);
    await gitExec(repoPath, ["remote", "add", "origin", remoteUrl]);
    const res = await request(app)
      .post("/api/repositories/manual")
      .send({ path: repoPath })
      .expect(201);
    return {
      projectId: res.body.repository.projectId as number,
      bindingId: res.body.repository.id as number,
    };
  }

  beforeEach(() => {
    setGhExecutorForTests(ghStub);
  });

  afterEach(() => {
    setGhExecutorForTests(null);
  });

  it("target with an existing explicit primary: the incoming binding stays non-primary", async () => {
    const tracked = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/adopt-explicit" })
      .expect(201);
    const target = tracked.body.projectId as number;

    // First local merges in and becomes the target's explicit primary
    // (GitHub-only target, zero prior locals).
    const first = await addLocalWithRemote("https://github.com/octo/adopt-explicit.git");
    expect(first.projectId).toBe(target);
    expect(primaryFlag(first.bindingId)).toBe(1);

    // A second local claiming the same identity must NOT steal the primary.
    const second = await addLocalWithRemote("https://github.com/octo/adopt-explicit.git");
    expect(second.projectId).toBe(target);
    expect(primaryFlag(first.bindingId)).toBe(1);
    expect(primaryFlag(second.bindingId)).toBe(0);
  });

  it("target with locals but zero explicit primary: MIN(id) becomes primary, not the incoming binding", async () => {
    const tracked = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/adopt-repair" })
      .expect(201);
    const target = tracked.body.projectId as number;

    const first = await addLocalWithRemote("https://github.com/octo/adopt-repair.git");
    expect(first.projectId).toBe(target);
    expect(primaryFlag(first.bindingId)).toBe(1);

    // Deliberate zero-primary repair state on the target.
    getDb()
      .prepare("UPDATE local_repositories SET is_primary = 0 WHERE project_id = ?")
      .run(target);

    // The fresh incoming binding (newest, highest id) must NOT take over:
    // the deterministic MIN(id) fallback is repaired instead.
    const second = await addLocalWithRemote("https://github.com/octo/adopt-repair.git");
    expect(second.projectId).toBe(target);
    expect(second.bindingId).toBeGreaterThan(first.bindingId);
    expect(primaryFlag(first.bindingId)).toBe(1); // MIN(id) repaired
    expect(primaryFlag(second.bindingId)).toBe(0);
  });

  it("GitHub-only target: the incoming binding becomes the project's first primary", async () => {
    const tracked = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/adopt-github-only" })
      .expect(201);
    const target = tracked.body.projectId as number;
    expect(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ?")
          .get(target) as { n: number }
      ).n,
    ).toBe(0);

    const incoming = await addLocalWithRemote("https://github.com/octo/adopt-github-only.git");
    expect(incoming.projectId).toBe(target);
    expect(primaryFlag(incoming.bindingId)).toBe(1);
  });
});


describe("new standalone binding via the real manual creation path", () => {
  it("POST /api/repositories/manual creates the Project with the first binding as exactly one primary", async () => {
    const repoPath = await createGitRepo();
    cleanup.push(repoPath);

    const created = await request(app)
      .post("/api/repositories/manual")
      .send({ path: repoPath })
      .expect(201);
    const repository = created.body.repository as {
      id: number;
      projectId: number | null;
      isPrimary: boolean;
    };
    // A brand-new Project is created for the standalone binding, and the
    // first local binding is its primary.
    expect(repository.projectId).not.toBeNull();
    expect(repository.isPrimary).toBe(true);
    expect(primaryFlag(repository.id)).toBe(1);

    const projectId = repository.projectId as number;

    // The list DTO exposes it as the server-authoritative effective primary.
    const listed = await request(app).get("/api/repositories").expect(200);
    const mine = (
      listed.body.repositories as Array<{ id: number; projectId: number; isPrimary: boolean }>
    ).filter((repo) => repo.projectId === projectId);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(repository.id);
    expect(mine[0].isPrimary).toBe(true);

    // Exactly one primary exists for that Project.
    expect(
      (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = ? AND is_primary = 1",
          )
          .get(projectId) as { n: number }
      ).n,
    ).toBe(1);
  });
});
