import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import { createGitRepo, useTempDb } from "./helpers.js";

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  app = createApp();
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function track(name: string): Promise<{ id: number }> {
  const repo = await createGitRepo();
  cleanup.push(repo);
  const res = await request(app).post("/api/repositories/manual").send({ path: repo });
  expect(res.status).toBe(201);
  const id = res.body.repository.id as number;
  await request(app)
    .patch(`/api/repositories/${id}/metadata`)
    .send({ projectNote: `${name} note` })
    .expect(200);
  return { id };
}

describe("Portfolio endpoint", () => {
  it("returns only flagged projects in nulls-last portfolio order", async () => {
    const a = await track("a");
    const b = await track("b");
    const c = await track("c");

    await request(app).patch(`/api/repositories/${b.id}/metadata`).send({
      includeInPortfolio: true,
      portfolioOrder: 1,
      projectNote: "Second position",
    }).expect(200);
    await request(app).patch(`/api/repositories/${a.id}/metadata`).send({
      includeInPortfolio: true,
      portfolioOrder: 2,
    }).expect(200);
    // c stays unflagged.

    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    const items = res.body.projects as Array<{
      id: number;
      portfolioOrder: number | null;
      projectNote: string | null;
      firstCommitAt: string | null;
      latestCommitAt: string | null;
      technologyHints: string[];
    }>;
    expect(items.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(items.every((item) => item.id !== c.id)).toBe(true);
    expect(items[0].portfolioOrder).toBe(1);
    expect(items[0].projectNote).toBe("Second position");
    // Real commit dates from tracked history.
    expect(items[0].firstCommitAt).toBeTruthy();
    expect(items[0].latestCommitAt).toBeTruthy();
    expect(Array.isArray(items[0].technologyHints)).toBe(true);
  });

  it("includes local-only projects and reflects reordering through the metadata API", async () => {
    const repo = await track("solo");
    await request(app).patch(`/api/repositories/${repo.id}/metadata`).send({
      includeInPortfolio: true,
      portfolioOrder: 5,
    }).expect(200);

    let res = await request(app).get("/api/portfolio");
    expect((res.body.projects as { id: number }[]).map((p) => p.id)).toEqual([repo.id]);
    expect(res.body.projects[0].githubHtmlUrl).toBeNull();

    const other = await track("other");
    await request(app).patch(`/api/repositories/${other.id}/metadata`).send({
      includeInPortfolio: true,
      portfolioOrder: 4,
    }).expect(200);
    // Swap positions via plain PATCHes (the same primitive the UI uses).
    await request(app).patch(`/api/repositories/${repo.id}/metadata`).send({ portfolioOrder: 4 }).expect(200);
    await request(app).patch(`/api/repositories/${other.id}/metadata`).send({ portfolioOrder: 5 }).expect(200);

    res = await request(app).get("/api/portfolio");
    expect((res.body.projects as { id: number }[]).map((p) => p.id)).toEqual([
      repo.id,
      other.id,
    ]);
  });

  it("returns an empty list when nothing is selected", async () => {
    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });
});
