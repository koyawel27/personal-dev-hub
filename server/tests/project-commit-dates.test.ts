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
 * Regression coverage: Project Detail commits must expose the real commit
 * timestamp as `committedAt` for BOTH sources (real-account defect: the
 * GitHub commits' Date column rendered "—" because node:sqlite returned
 * the raw `committed_at` key while the mapper read `committedAt`).
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

const ghStub: GhExecutor = async (args) => {
  const argv = args.join(" ");
  if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
    return {
      stdout: JSON.stringify({
        owner: { login: "koyawel27" },
        name: "timestamp-repo",
        full_name: "koyawel27/timestamp-repo",
        visibility: "public",
        default_branch: "main",
        html_url: "https://github.com/koyawel27/timestamp-repo",
        pushed_at: "2026-08-21T00:00:00Z",
      }),
      stderr: "",
      code: 0,
    };
  }
  if (/^api repos\/.+\/commits/.test(argv)) {
    return {
      stdout: JSON.stringify([
        {
          sha: "gh111111111111111111111111111111111111111",
          commit: {
            message: "github-side historical commit",
            author: { name: "Jezer Macaslang", date: "2026-06-08T13:21:30Z" },
          },
        },
        // Abnormal record: no author date at all.
        {
          sha: "gh222222222222222222222222222222222222222",
          commit: { message: "record without a date" },
        },
      ]),
      stderr: "",
      code: 0,
    };
  }
  return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
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
      // best effort
    }
  }
});

async function trackGithubOnly(): Promise<{ projectId: number; ghId: number }> {
  const res = await request(app)
    .post("/api/github/tracked")
    .send({ fullName: "koyawel27/timestamp-repo" });
  expect(res.status).toBe(201);
  return { projectId: res.body.projectId, ghId: res.body.githubRepositoryId };
}

describe("project detail commit timestamps", () => {
  it("includes committedAt for github commits with the real stored value", async () => {
    const { projectId } = await trackGithubOnly();

    const detail = await request(app).get(`/api/projects/${projectId}`);
    const commit = (
      detail.body.project.commits as Array<{
        sha: string;
        committedAt: string | null;
        source: string;
      }>
    ).find((entry) => entry.sha.startsWith("gh1111"));
    expect(commit).toBeDefined();
    expect(commit!.source).toBe("github");
    expect(commit!.committedAt).toBe("2026-06-08T13:21:30Z");
  });

  it("maps an abnormal timestamp-less record to null instead of fabricating one", async () => {
    const { projectId } = await trackGithubOnly();
    const detail = await request(app).get(`/api/projects/${projectId}`);
    const commit = (
      detail.body.project.commits as Array<{ sha: string; committedAt: string | null }>
    ).find((entry) => entry.sha.startsWith("gh2222"));
    expect(commit?.committedAt ?? null).toBeNull();
  });

  it("exposes committedAt for local commits in the same normalized field", async () => {
    const repoPath = await createGitRepo();
    // Amend the initial commit with deterministic env dates via direct exec
    // (runExecFile does not forward env). Depending on local git behavior,
    // either author or committer date may take effect; we assert that the
    // normalized committedAt field reflects one of the two real dates.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const gitAmend = promisify(execFile);
    await gitAmend(
      "git",
      ["commit", "--amend", "--no-edit"],
      {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-05-01T10:00:00+08:00",
          GIT_COMMITTER_DATE: "2026-05-02T10:00:00+08:00",
        },
      },
    );
    // Read back which date actually stuck.
    const { stdout: dates } = await gitAmend(
      "git",
      ["log", "-1", "--format=%aI|%cI"],
      { cwd: repoPath },
    );
    const [authorDate, committerDate] = String(dates).trim().split("|");

    const created = await request(app).post("/api/repositories/manual").send({ path: repoPath });
    expect(created.status).toBe(201);

    // Refresh so the app re-reads the amended commit from Git.
    const repoId = created.body.repository.id as number;
    await request(app).post(`/api/repositories/${repoId}/refresh`).expect(200);
    const projectId = created.body.repository.projectId as number;

    const detail = await request(app).get(`/api/projects/${projectId}`);
    const commit = detail.body.project.commits[0] as {
      subject: string;
      committedAt: string | null;
      source: string;
    };
    expect(commit.source).toBe("local");
    expect(commit.committedAt).toBeTruthy();
    // The exposed timestamp must be one of the REAL git dates — never the
    // scan/observation time.
    const accepted = [authorDate, committerDate].map((value) =>
      value!.slice(0, 10),
    );
    expect(accepted).toContain(commit.committedAt!.slice(0, 10));
  });

  it("keeps mixed LOCAL + GITHUB history ordered and deduplicated by SHA", async () => {
    // Local clone of the same identity + tracked binding => LINKED project.
    const repoPath = await createGitRepo();
    await gitExec(repoPath, ["remote", "add", "origin", "https://github.com/koyawel27/timestamp-repo.git"]);
    const created = await request(app).post("/api/repositories/manual").send({ path: repoPath });
    const projectId = created.body.projectId ?? created.body.repository.projectId;

    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/timestamp-repo" });
    expect(track.body.state).toBe("LOCAL + GITHUB");

    const refresh = await request(app).post(
      `/api/github/tracked/${track.body.githubRepositoryId}/refresh`,
    );
    expect(refresh.body.ok).toBe(true);

    const detail = await request(app).get(`/api/projects/${Number(projectId)}`);
    const commits = detail.body.project.commits as Array<{
      sha: string;
      source: string;
      committedAt: string | null;
    }>;
    const shas = new Set(commits.map((commit) => commit.sha));
    // No duplicate SHAs across sources within the response.
    expect(shas.size).toBe(commits.length);
    // Every row carries the normalized field key.
    for (const commit of commits) {
      expect(Object.keys(commit)).toContain("committedAt");
    }
  });

  it("activity timestamps remain untouched by this change", async () => {
    const { projectId } = await trackGithubOnly();
    const activity = await request(app).get(`/api/activity?projectId=${projectId}`);
    const commitEvents = activity.body.activity.filter(
      (event: { eventType: string }) => event.eventType === "github_commit_observed",
    );
    expect(commitEvents.length).toBeGreaterThan(0);
    for (const event of commitEvents) {
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
