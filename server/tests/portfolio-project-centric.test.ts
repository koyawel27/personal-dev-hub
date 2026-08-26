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
import { createGitRepo, gitExec, useTempDb } from "./helpers.js";

/**
 * Regression coverage: Portfolio mutations are PROJECT-centric.
 *
 * Owner-found defect: Portfolio Remove/Reorder called the legacy
 * PATCH /api/repositories/:id/metadata with a PROJECT id. For GITHUB ONLY
 * projects (no local binding) that endpoint correctly answered 404
 * REPOSITORY_NOT_FOUND, so Remove silently did nothing.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

function ghStubFor(fullName: string): GhExecutor {
  const [owner, name] = fullName.split("/");
  return async (args) => {
    const argv = args.join(" ");
    if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
      return {
        stdout: JSON.stringify({
          owner: { login: owner },
          name,
          full_name: fullName,
          visibility: "public",
          default_branch: "main",
          html_url: `https://github.com/${owner}/${name}`,
          pushed_at: "2026-07-01T00:00:00Z",
        }),
        stderr: "",
        code: 0,
      };
    }
    if (/^api repos\/.+\/commits/.test(argv)) {
      return {
        stdout: JSON.stringify([
          {
            sha: `deadbeef${fullName.split("/")[1]!.padEnd(24, "0").slice(0, 24)}`,
            commit: {
              message: `${name} history`,
              author: { name: "Dev", date: "2026-06-15T09:00:00Z" },
            },
          },
        ]),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
  };
}

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
});

afterEach(() => {
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

async function trackGithubOnly(fullName: string) {
  setGhExecutorForTests(ghStubFor(fullName));
  const track = await request(app).post("/api/github/tracked").send({ fullName });
  expect(track.status).toBe(201);
  // Initial refresh stores history; make it portfolio-worthy explicitly.
  await request(app)
    .patch(`/api/projects/${track.body.projectId}/metadata`)
    .send({ includeInPortfolio: true, portfolioOrder: 1 });
  return track.body as { projectId: number; githubRepositoryId: number };
}

async function addLocalProject(remote?: string) {
  const repoPath = await createGitRepo();
  if (remote) {
    await gitExec(repoPath, ["remote", "add", "origin", remote]);
  }
  const created = await request(app).post("/api/repositories/manual").send({ path: repoPath });
  expect(created.status).toBe(201);
  const projectId = created.body.repository.projectId as number;
  await request(app)
    .patch(`/api/projects/${projectId}/metadata`)
    .send({ includeInPortfolio: true, projectNote: "local work" });
  return { projectId, repoId: created.body.repository.id as number, repoPath };
}

describe("project-centric portfolio mutations", () => {
  it("GITHUB ONLY project can be removed from Portfolio via PROJECT identity", async () => {
    const { projectId, githubRepositoryId } = await trackGithubOnly("koyawel27/Test-Folder");

    // The defect scenario: remove through the project-centric endpoint.
    const patch = await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send({ includeInPortfolio: false });
    expect(patch.status).toBe(200);

    const portfolio = (await request(app).get("/api/portfolio")).body.projects as Array<{
      id: number;
    }>;
    expect(portfolio.some((item) => item.id === projectId)).toBe(false);

    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.body.project.includeInPortfolio).toBe(false);
    expect(detail.body.project.sourceState).toBe("GITHUB ONLY");

    // Project stays tracked; GitHub binding untouched.
    const picker = await request(app).get("/api/github/repositories");
    const entry = (
      picker.body.entries as Array<{ fullName: string; trackedBindingId: number | null }>
    ).find((candidate) => candidate.fullName === "koyawel27/Test-Folder");
    expect(entry?.trackedBindingId).toBe(githubRepositoryId);
  });

  it("LOCAL ONLY removal still works through the same project path", async () => {
    const { projectId } = await addLocalProject();
    const patch = await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send({ includeInPortfolio: false });
    expect(patch.status).toBe(200);
    const portfolio = (await request(app).get("/api/portfolio")).body.projects as Array<{
      id: number;
    }>;
    expect(portfolio.some((item) => item.id === projectId)).toBe(false);
  });

  it("LOCAL + GITHUB removal works and leaves both bindings intact", async () => {
    const local = await addLocalProject("https://github.com/koyawel27/linked-portfolio.git");
    setGhExecutorForTests(ghStubFor("koyawel27/linked-portfolio"));
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/linked-portfolio" });
    expect(track.body.state).toBe("LOCAL + GITHUB");

    const patch = await request(app)
      .patch(`/api/projects/${track.body.projectId}/metadata`)
      .send({ includeInPortfolio: false });
    expect(patch.status).toBe(200);

    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    expect(detail.body.project.sourceState).toBe("LOCAL + GITHUB"); // binding unchanged
    expect(detail.body.project.includeInPortfolio).toBe(false);

    // Local binding still present.
    const repos = await request(app).get("/api/repositories");
    expect(
      (repos.body.repositories as Array<{ id: number }>).some((repo) => repo.id === local.repoId),
    ).toBe(true);
  });

  it("reorder works for GITHUB ONLY projects using project identity", async () => {
    const first = await trackGithubOnly("koyawel27/order-one");
    await request(app)
      .patch(`/api/projects/${first.projectId}/metadata`)
      .send({ includeInPortfolio: true, portfolioOrder: 1 });
    const second = await trackGithubOnly("koyawel27/order-two");
    await request(app)
      .patch(`/api/projects/${second.projectId}/metadata`)
      .send({ includeInPortfolio: true, portfolioOrder: 2 });

    // Swap orders exactly like the Portfolio up/down buttons do.
    await request(app)
      .patch(`/api/projects/${first.projectId}/metadata`)
      .send({ portfolioOrder: 2 });
    await request(app)
      .patch(`/api/projects/${second.projectId}/metadata`)
      .send({ portfolioOrder: 1 });

    const portfolio = (
      await request(app).get("/api/portfolio")
    ).body.projects as Array<{ id: number; portfolioOrder: number | null }>;
    expect(portfolio[0].id).toBe(second.projectId);
    expect(portfolio[1].id).toBe(first.projectId);
  });

  it("mixed-source reorder keeps LOCAL ONLY and GITHUB ONLY consistent", async () => {
    const gh = await trackGithubOnly("koyawel27/mixed-gh");
    await request(app)
      .patch(`/api/projects/${gh.projectId}/metadata`)
      .send({ includeInPortfolio: true, portfolioOrder: 2 });
    const local = await addLocalProject();
    await request(app)
      .patch(`/api/projects/${local.projectId}/metadata`)
      .send({ includeInPortfolio: true, portfolioOrder: 1 });

    // Move the GitHub-only item above the local one (project path only).
    await request(app)
      .patch(`/api/projects/${gh.projectId}/metadata`)
      .send({ portfolioOrder: 1 });
    await request(app)
      .patch(`/api/projects/${local.projectId}/metadata`)
      .send({ portfolioOrder: 2 });

    const portfolio = (
      await request(app).get("/api/portfolio")
    ).body.projects as Array<{ id: number }>;
    expect(portfolio.map((item) => item.id)).toEqual([gh.projectId, local.projectId]);
  });

  it("failed mutation leaves portfolio membership unchanged", async () => {
    const { projectId } = await trackGithubOnly("koyawel27/keep-me");
    const bad = await request(app)
      .patch("/api/projects/999999/metadata")
      .send({ includeInPortfolio: false });
    expect(bad.status).toBe(404);

    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.body.project.includeInPortfolio).toBe(true);
    const portfolio = (await request(app).get("/api/portfolio")).body.projects as Array<{
      id: number;
    }>;
    expect(portfolio.some((item) => item.id === projectId)).toBe(true);
  });

  it("retired repository metadata route no longer exists (identity guard)", async () => {
    // V1.1 cleanup: PATCH /api/repositories/:id/metadata is GONE. The only
    // metadata mutation path is the Project route carrying a PROJECT id, so
    // the repository-as-project identity mistake cannot silently succeed.
    const { projectId } = await trackGithubOnly("koyawel27/no-repo-binding");
    const legacyAttempt = await request(app)
      .patch(`/api/repositories/${projectId}/metadata`)
      .send({ includeInPortfolio: false });
    expect(legacyAttempt.status).toBe(404); // no route, no shim, no mutation

    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.body.project.includeInPortfolio).toBe(true); // untouched
  });
});
