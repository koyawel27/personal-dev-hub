import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  createGitRepo,
  gitExec,
  makeTempDir,
  useTempDb,
} from "./helpers.js";

/**
 * Milestone GC — project-centric domain behavior:
 * - track/link (no duplicate projects)
 * - GitHub-only creation
 * - reverse match when a local clone appears later
 * - Q1 untrack/disconnect lifecycle
 * - metadata survives state transitions
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
      // Windows temp locks; best effort
    }
  }
});

async function addLocalRepo(options?: { remote?: string; dirty?: boolean }) {
  const repoPath = await createGitRepo({ dirty: options?.dirty });
  if (options?.remote) {
    await gitExec(repoPath, ["remote", "add", "origin", options.remote]);
  }
  const res = await request(app).post("/api/repositories/manual").send({ path: repoPath });
  expect(res.status).toBe(201);
  return { repoId: res.body.repository.id as number, repoPath };
}

describe("project-centric tracking", () => {
  it("links a picked GitHub repository to the existing local project (no duplicate)", async () => {
    const { repoId } = await addLocalRepo({
      remote: "https://github.com/octocat/linkme.git",
    });

    const trackRes = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octocat/linkme" });
    expect(trackRes.status).toBe(201);
    expect(trackRes.body.state).toBe("LOCAL + GITHUB");
    expect(trackRes.body.projectId).toBe(
      (
        getDb()
          .prepare("SELECT project_id AS p FROM local_repositories WHERE id = ?")
          .get(repoId) as { p: number }
      ).p,
    );

    // Exactly one project exists for this identity.
    const list = await request(app).get("/api/projects?query=linkme");
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].sourceState).toBe("LOCAL + GITHUB");

    // Double-track is rejected as already tracked.
    const again = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octocat/linkme" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_TRACKED");
  });

  it("creates a GITHUB ONLY project with no fabricated local state", async () => {
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "someone/remote-only" });
    expect(track.status).toBe(201);
    expect(track.body.state).toBe("GITHUB ONLY");

    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    expect(detail.status).toBe(200);
    const project = detail.body.project;
    expect(project.sourceState).toBe("GITHUB ONLY");
    // No fabricated local state:
    expect(project.localPath).toBeNull();
    expect(project.snapshot).toBeNull();
    // GitHub identity present:
    expect(project.githubFullName.toLowerCase()).toBe("someone/remote-only");
    expect(project.githubHtmlUrl).toContain("github.com/someone/remote-only");
  });

  it("upgrades GITHUB ONLY to LOCAL + GITHUB when a clone is discovered later", async () => {
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octocat/later-clone" });
    const projectId = track.body.projectId as number;

    // A local copy appears later, discovered through a scan source.
    const repoPath = await createGitRepo();
    await gitExec(repoPath, [
      "remote",
      "add",
      "origin",
      "git@github.com:octocat/later-clone.git",
    ]);
    const srcDir = makeTempDir("ldd-src-");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.renameSync(repoPath, path.join(srcDir, "later-clone"));
    const src = await request(app)
      .post("/api/sources")
      .send({ path: srcDir, scanDepth: 1 });
    expect(src.status).toBe(201);
    const scan = await request(app).post("/api/scans");
    expect(scan.status).toBe(200);

    // The tracked project must have absorbed the binding — no duplicates.
    const list = await request(app).get("/api/projects?query=later-clone");
    const matches = list.body.projects as Array<{ id: number; sourceState: string }>;
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(projectId);
    expect(matches[0].sourceState).toBe("LOCAL + GITHUB");
  });

  it("disconnects GitHub from LOCAL + GITHUB and preserves metadata", async () => {
    const { repoId } = await addLocalRepo({
      remote: "https://github.com/octocat/disconnect-me.git",
    });
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octocat/disconnect-me" });
    const ghId = track.body.githubRepositoryId as number;

    await request(app)
      .patch(`/api/projects/${track.body.projectId}/metadata`)
      .send({ projectStatus: "Active", projectNote: "keep me" });

    const del = await request(app).delete(`/api/github/tracked/${ghId}`);
    expect(del.status).toBe(200);
    expect(del.body.projectDeleted).toBe(false);

    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    expect(detail.body.project.sourceState).toBe("LOCAL ONLY");
    expect(detail.body.project.projectStatus).toBe("Active");
    expect(detail.body.project.projectNote).toBe("keep me");

    // The local repository itself is untouched.
    expect(fs.existsSync((await request(app).get(`/api/repositories/${repoId}`)).body.repository.localPath)).toBe(true);
  });

  it("untracks GITHUB ONLY: auto-deletes empty projects, confirms curated ones", async () => {
    // Empty auto-created project -> deleted without confirmation.
    const empty = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/empty-shell" });
    const emptyDel = await request(app).delete(
      `/api/github/tracked/${empty.body.githubRepositoryId}`,
    );
    expect(emptyDel.status).toBe(200);
    expect(emptyDel.body.projectDeleted).toBe(true);
    const goneCheck = await request(app).get(`/api/projects/${empty.body.projectId}`);
    expect(goneCheck.status).toBe(404);

    // Curated project (has note) -> refused until confirmed.
    const curated = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/curated-only" });
    await request(app)
      .patch(`/api/projects/${curated.body.projectId}/metadata`)
      .send({ projectNote: "historical value" });
    const refused = await request(app).delete(
      `/api/github/tracked/${curated.body.githubRepositoryId}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PROJECT_HAS_NO_SOURCES");
    const confirmed = await request(app).delete(
      `/api/github/tracked/${curated.body.githubRepositoryId}?confirmDeleteProject=true`,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.projectDeleted).toBe(true);

    // GitHub itself was never touched by any of this (no clone dirs created).
  });

  it("rejects hostile or malformed fullName values", async () => {
    for (const bad of ["../etc", "a/b/c", "no-slash", "", "a b/c d", "x/$(..)"]) {
      const res = await request(app).post("/api/github/tracked").send({ fullName: bad });
      expect(res.status).toBe(400);
    }
  });
});
