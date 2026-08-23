import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { resolveGitPath } from "../src/lib/gitRunner.js";
import { runExecFile } from "../src/lib/processRunner.js";
import { makeTempDir, useTempDb } from "./helpers.js";

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
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runExecFile(resolveGitPath(), args, { cwd, timeout: 20_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** Repo whose single commit carries a fixed author date (drives %aI). */
async function createDatedRepo(name: string, isoDate: string): Promise<string> {
  const dir = makeTempDir(`ldd-contrib-${name}-`);
  cleanup.push(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "dev@example.com"]);
  await git(dir, ["config", "user.name", "Dev"]);
  fs.writeFileSync(path.join(dir, "README.md"), `hello from ${name}\n`);
  process.env.GIT_AUTHOR_DATE = isoDate;
  process.env.GIT_COMMITTER_DATE = isoDate;
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", `initial ${name}`]);
  return dir;
}

/**
 * Two byte-identical commits (same tree, author, committer, timestamps)
 * produce the same SHA — exactly the cross-repository duplicate case the
 * combined view must not double-count.
 */
async function createIdenticalCommitRepos(): Promise<[string, string]> {
  const make = async (name: string): Promise<string> => {
    const dir = makeTempDir(`ldd-twin-${name}-`);
    cleanup.push(dir);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "dev@example.com"]);
    await git(dir, ["config", "user.name", "Dev"]);
    fs.writeFileSync(path.join(dir, "README.md"), "identical content\n");
    return dir;
  };
  const a = await make("a");
  const b = await make("b");
  process.env.GIT_AUTHOR_DATE = "2026-03-10T09:00:00+08:00";
  process.env.GIT_COMMITTER_DATE = "2026-03-10T09:00:00+08:00";
  await git(a, ["add", "README.md"]);
  await git(b, ["add", "README.md"]);
  await git(a, ["commit", "-m", "same change"]);
  await git(b, ["commit", "-m", "same change"]);
  return [a, b];
}

async function track(path: string): Promise<number> {
  const res = await request(app).post("/api/repositories/manual").send({ path });
  expect(res.status).toBe(201);
  return res.body.repository.id as number;
}

describe("Contribution aggregation", () => {
  it("aggregates local commit counts by day within a range", async () => {
    const repo = await createDatedRepo("one", "2026-05-01T10:00:00+08:00");
    await track(repo);

    const res = await request(app).get(
      "/api/contributions?from=2026-04-01T00:00:00Z&to=2026-06-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    const days = res.body.days as { date: string; total: number; localCount: number; githubCount: number }[];
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-05-01");
    expect(days[0].total).toBe(1);
    expect(days[0].localCount).toBe(1);
    expect(days[0].githubCount).toBe(0);
  });

  it("returns an empty list for ranges without activity", async () => {
    const res = await request(app).get(
      "/api/contributions?from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual([]);
  });

  it("never double-counts the same commit SHA across repositories", async () => {
    const [repoA, repoB] = await createIdenticalCommitRepos();
    await track(repoA);
    await track(repoB);

    // Sanity: the twin commits really are the same SHA.
    const listed = await request(app).get("/api/repositories");
    const details = await Promise.all(
      (listed.body.repositories as { id: number }[]).map((repo) =>
        request(app).get(`/api/repositories/${repo.id}`),
      ),
    );
    const shas = details.map((detail) => detail.body.repository.commits[0].sha as string);
    expect(shas[0]).toBe(shas[1]);

    const res = await request(app).get("/api/contributions");
    const days = res.body.days as { date: string; total: number }[];
    expect(days).toHaveLength(1);
    // Two repositories observed the same commit; the day counts it once.
    expect(days[0].total).toBe(1);
  });

  it("exposes daily detail grouped per project without hour claims", async () => {
    const repo = await createDatedRepo("detail", "2026-07-04T14:30:00+08:00");
    await track(repo);

    const res = await request(app).get("/api/contributions/2026-07-04");
    expect(res.status).toBe(200);
    expect(res.body.date).toBe("2026-07-04");
    const projects = res.body.projects as {
      repositoryId: number;
      projectName: string;
      commits: { sha: string; subject: string; committedAt: string }[];
    }[];
    expect(projects).toHaveLength(1);
    expect(projects[0].commits).toHaveLength(1);
    expect(projects[0].commits[0].subject).toBe("initial detail");
    // The response shape carries activity counts only — never time/worked fields.
    expect(JSON.stringify(res.body)).not.toMatch(/hours|worked|productivity/i);
  });

  it("rejects malformed day identifiers", async () => {
    const res = await request(app).get("/api/contributions/not-a-date");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
  });
});
