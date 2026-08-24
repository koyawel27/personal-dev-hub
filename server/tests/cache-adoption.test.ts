import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  setGhExecutorForTests,
  type GhExecutor,
} from "../src/services/GitHubService.js";
import {
  createGitRepo,
  gitExec,
  makeTempDir,
  useTempDb,
} from "./helpers.js";

/**
 * Regression coverage for the real-account defect:
 * "existing GitHub cache row cannot be tracked".
 *
 * Pre-V1.1 enrichment rows carry project_id/owner_norm/name_norm/tracked_at
 * as NULL. Tracking such an identity must ADOPT the row (guarded UPDATE,
 * same id, cached metadata preserved) — never insert a duplicate against
 * UNIQUE(owner, name), never create a duplicate Project.
 *
 * gh is stubbed so metadata freshness is deterministic (no live GitHub).
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

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

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
  setGhExecutorForTests(ghStub);
});

afterEach(() => {
  setGhExecutorForTests(null);
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows temp locks; best effort
    }
  }
});

/** Seed a legacy enrichment row exactly like pre-V1.1 cache writes. */
function seedLegacyCacheRow(fullName: string): number {
  const [owner, name] = fullName.split("/");
  const result = getDb()
    .prepare(
      `INSERT INTO github_repositories
        (owner, name, full_name, visibility, default_branch, html_url,
         last_pushed_at, last_refreshed_at)
       VALUES (?, ?, ?, 'private', 'main', ?, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')`,
    )
    .run(owner, name, fullName, `https://github.com/${owner}/${name}`);
  return Number(result.lastInsertRowid);
}

function ghRow(id: number): {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  owner_norm: string | null;
  name_norm: string | null;
  project_id: number | null;
  tracked_at: string | null;
  visibility: string | null;
  default_branch: string | null;
  html_url: string | null;
  last_pushed_at: string | null;
  last_refreshed_at: string | null;
} {
  return getDb().prepare("SELECT * FROM github_repositories WHERE id = ?").get(id) as never;
}

async function addLocalRepoWithRemote(remoteUrl: string) {
  const repoPath = await createGitRepo();
  await gitExec(repoPath, ["remote", "add", "origin", remoteUrl]);
  const res = await request(app).post("/api/repositories/manual").send({ path: repoPath });
  expect(res.status).toBe(201);
  return {
    repoId: res.body.repository.id as number,
    projectId: res.body.repository.projectId as number,
  };
}

describe("legacy GitHub cache adoption on track", () => {
  it("adopts the legacy row, keeps its id and metadata, links the local project", async () => {
    const legacyId = seedLegacyCacheRow("koyawel27/bpc-learnshare");
    const { projectId } = await addLocalRepoWithRemote(
      "https://github.com/koyawel27/bpc-learnshare.git",
    );

    const projectsBefore = (
      getDb().prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }
    ).n;

    const res = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/bpc-learnshare" });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("LOCAL + GITHUB");

    const row = ghRow(legacyId);
    expect(row.id).toBe(legacyId); // same physical row adopted
    expect(row.project_id).toBe(projectId);
    expect(row.tracked_at).toBeTruthy();
    expect(row.owner_norm).toBe("koyawel27");
    expect(row.name_norm).toBe("bpc-learnshare");
    // Fresh metadata (from stub gh) merged in; nothing nulled out.
    expect(row.visibility).toBe("public");
    expect(row.default_branch).toBe("main");
    expect(row.html_url).toBe("https://github.com/koyawel27/bpc-learnshare");
    expect(row.last_pushed_at).toBe("2026-08-01T00:00:00Z");
    expect(row.last_refreshed_at).toBeTruthy();

    // No duplicate project, no duplicate GitHub row.
    const projectsAfter = (
      getDb().prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }
    ).n;
    expect(projectsAfter).toBe(projectsBefore);
    const ghRows = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM github_repositories WHERE lower(full_name) = 'koyawel27/bpc-learnshare'",
      )
      .get() as { n: number };
    expect(ghRows.n).toBe(1);

    // Source state is LOCAL + GITHUB.
    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.body.project.sourceState).toBe("LOCAL + GITHUB");
    expect(detail.body.project.githubFullName.toLowerCase()).toBe(
      "koyawel27/bpc-learnshare",
    );
  });

  it("returns a deterministic conflict when the row belongs to another project", async () => {
    // First project tracks the identity through its own local remote.
    await addLocalRepoWithRemote("https://github.com/octo/shared.git");
    const firstTrack = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/shared" });
    expect(firstTrack.status).toBe(201);

    // A different local repo + project also claims the same identity.
    const second = await addLocalRepoWithRemote("https://github.com/octo/shared.git");
    void second;

    // The row is already linked to the FIRST project; re-tracking must not
    // reassign it.
    const before = ghRow(firstTrack.body.githubRepositoryId as number);
    const conflict = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octo/shared" });
    expect(conflict.status).toBe(409);
    expect(["ALREADY_TRACKED", "GITHUB_REPO_CONFLICT"]).toContain(
      conflict.body.error.code,
    );
    const after = ghRow(firstTrack.body.githubRepositoryId as number);
    expect(after.project_id).toBe(before.project_id);
    // No new github rows or projects appeared.
    expect(
      (getDb().prepare("SELECT COUNT(*) AS n FROM github_repositories").get() as { n: number }).n,
    ).toBe(1);
  });

  it("keeps the database unchanged when a tracking request fails", async () => {
    const legacyId = seedLegacyCacheRow("octo/failing-case");
    const snapshot = ghRow(legacyId);

    // Malformed payload fails validation before any write.
    const bad = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "not-a-full-name" });
    expect(bad.status).toBe(400);

    const after = ghRow(legacyId);
    expect(after.project_id).toBe(snapshot.project_id);
    expect(after.tracked_at).toBeNull();
    expect(
      (getDb().prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n,
    ).toBe(0);
  });

  it("still creates a GitHub-only project when no local match exists", async () => {
    const res = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "someone/no-clone" });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("GITHUB ONLY");
    const detail = await request(app).get(`/api/projects/${res.body.projectId}`);
    expect(detail.body.project.localPath).toBeNull();
  });
});
