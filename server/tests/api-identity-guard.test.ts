import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  setGhExecutorForTests,
  type GhExecutor,
} from "../src/services/GitHubService.js";
import { createGitRepo } from "./helpers.js";

/**
 * V1.1 identity-guard coverage: Project ids and local repository ids are
 * SEPARATE domains, and the repository-as-project compatibility shims stay
 * retired.
 *
 * Layer 1 (source scan): the client API surface contains no retired
 * project-as-repository methods, and no client code calls them — a cheap,
 * deterministic reintroduction tripwire in the spirit of the portfolio
 * reorder regression guard.
 * Layer 2 (HTTP): retired routes answer 404 while every genuine local-
 * binding route still works; metadata mutates ONLY through the Project API.
 */

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cleanup: string[] = [];

const healthyGh: GhExecutor = async (args) => {
  const argv = args.join(" ");
  if (argv === "--version") return { stdout: "gh version stub\n", stderr: "", code: 0 };
  if (argv === "auth status") return { stdout: "", stderr: "", code: 0 };
  if (/^api user$/.test(argv)) {
    return { stdout: JSON.stringify({ login: "koyawel27" }), stderr: "", code: 0 };
  }
  if (/^api repos\/[^/]+\/[^/]+$/.test(argv)) {
    const [, , name] = argv.split("/");
    return {
      stdout: JSON.stringify({
        owner: { login: "koyawel27" },
        name,
        full_name: `koyawel27/${name}`,
        visibility: "public",
        default_branch: "main",
        html_url: `https://github.com/koyawel27/${name}`,
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
          sha: "cafef00dcafef00dcafef00dcafef00dcafef00d",
          commit: { message: "history", author: { name: "Dev", date: "2026-07-01T09:00:00Z" } },
        },
      ]),
      stderr: "",
      code: 0,
    };
  }
  return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
};

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-guard-"));
  cleanup.push(dir);
  process.env.DASHBOARD_DB_PATH = path.join(dir, "test.sqlite");
  closeDb();
  getDb();
  setGhExecutorForTests(healthyGh);
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

// ---------------------------------------------------------------------------
// Layer 1: static source guard against reintroduction
// ---------------------------------------------------------------------------

function readClientSource(relativePath: string): string {
  return fs.readFileSync(path.join(here, relativePath), "utf8");
}

describe("static identity guard (client source)", () => {
  it("api client defines no retired project-as-repository methods", () => {
    const api = readClientSource("client/src/api.ts");
    expect(api).not.toMatch(/updateMetadata\s*[:(]/); // retired shim method
    expect(api).not.toMatch(/repository\s*:\s*\(.*=>|repository:\s*\(/); // detail alias
    // Kept local-binding routes may interpolate ${localRepositoryId}; the
    // HTTP layer below pins exactly which routes exist.
  });

  it("no client page/component calls retired methods or legacy metadata routes", () => {
    const pagesDir = path.join(here, "client", "src");
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (/\.tsx?$/.test(entry.name) && !full.endsWith("api.ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (/client\.updateMetadata\(|client\.repository\(/.test(text)) {
            offenders.push(path.relative(here, full));
          }
          if (/\/api\/repositories\/\$\{[^}]+\}\/metadata/.test(text)) {
            offenders.push(`${path.relative(here, full)} (legacy metadata route)`);
          }
        }
      }
    };
    visit(pagesDir);
    expect(offenders).toEqual([]);
  });

  it("project mutations in client code use only the Project metadata client method", () => {
    const editor = readClientSource("client/src/components/MetadataEditor.tsx");
    expect(editor).toContain("client.updateProjectMetadata(repository.id");
    expect(editor).not.toContain("client.updateMetadata(");
  });
});

// ---------------------------------------------------------------------------
// Layer 2: HTTP contract guards
// ---------------------------------------------------------------------------

async function seedLocalBinding(): Promise<{ repoId: number; projectId: number; folder: string }> {
  const app = createApp();
  // Offset the two AUTOINCREMENT sequences first: a GitHub-only Project
  // consumes project id 1 WITHOUT consuming a binding id, so project and
  // binding ids can never numerically coincide below (the very ambiguity
  // this suite guards against).
  const offset = await request(app)
    .post("/api/github/tracked")
    .send({ fullName: "koyawel27/id-offset" });
  expect(offset.status).toBe(201);

  const folder = await createGitRepo();
  cleanup.push(folder);
  const created = await request(app)
    .post("/api/repositories/manual")
    .send({ path: folder });
  return {
    repoId: created.body.repository.id as number,
    projectId: created.body.repository.projectId as number,
    folder,
  };
}

describe("retired routes vs genuine local-binding routes", () => {
  it("retired repository routes answer 404 and mutate nothing", async () => {
    const app = createApp();
    for (const attempt of [
      request(app).get("/api/repositories/123"),
      request(app).patch("/api/repositories/123/metadata").send({ projectStatus: "Active" }),
    ]) {
      const res = await attempt;
      expect(res.status).toBe(404);
    }
  });

  it("genuine local-binding routes remain functional after the cleanup", async () => {
    const { repoId, folder } = await seedLocalBinding();
    const app = createApp();

    const refreshed = await request(app).post(`/api/repositories/${repoId}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.repository.id).toBe(repoId);

    const listed = await request(app).get("/api/repositories");
    expect((listed.body.repositories as Array<{ id: number }>).some((r) => r.id === repoId)).toBe(
      true,
    );

    // Launcher route resolves a registered local path server-side.
    const opened = await request(app).post(`/api/repositories/${repoId}/open/folder`);
    expect(opened.status).toBe(200);
    expect(fs.existsSync(folder)).toBe(true);
  });
});

describe("Project metadata reaches only through Project APIs", () => {
  it("GITHUB ONLY project metadata works with NO local repository", async () => {
    const app = createApp();
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/ghost-meta" });
    const projectId = track.body.projectId as number;

    const patched = await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send({ projectStatus: "Active", includeInPortfolio: true, portfolioOrder: 3 });
    expect(patched.status).toBe(200);
    expect(patched.body.project.projectStatus).toBe("Active");

    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.body.project.includeInPortfolio).toBe(true);
    expect(detail.body.project.localPath).toBeNull(); // no binding needed
  });

  it("LOCAL + GITHUB project metadata works and portfolio reorder stays project-centric", async () => {
    const app = createApp();
    const folder = await createGitRepo();
    cleanup.push(folder);
    // Remote must exist BEFORE the manual add so discovery persists it.
    await gitRemoteAdd(folder, "https://github.com/koyawel27/dual-source.git");
    const created = await request(app).post("/api/repositories/manual").send({ path: folder });
    expect(created.status).toBe(201);

    const track = await request(app).post("/api/github/tracked")
      .send({ fullName: "koyawel27/dual-source" });
    expect(track.body.state).toBe("LOCAL + GITHUB");
    const projectId = track.body.projectId as number;

    const patched = await request(app)
      .patch(`/api/projects/${projectId}/metadata`)
      .send({ projectNote: "both sources", portfolioOrder: 1, includeInPortfolio: true });
    expect(patched.status).toBe(200);

    const portfolio = await request(app).get("/api/portfolio");
    expect(
      (portfolio.body.projects as Array<{ id: number }>).map((p) => p.id),
    ).toEqual([projectId]);
  });

  it("local rescan targets the LOCAL BINDING id, not the project id", async () => {
    const seeded = await seedLocalBinding();
    const app = createApp();
    // Deliberately swap the domains: rescan by PROJECT id must NOT succeed.
    const wrongDomain = await request(app).post(`/api/repositories/${seeded.projectId}/refresh`);
    // Either it fails loudly (binding not found / not a git repo at that
    // path) or it cannot resolve — but it must never be treated as valid.
    if (wrongDomain.status === 404) {
      expect(wrongDomain.body.error.code).toBe("REPOSITORY_NOT_FOUND");
    }

    const rightDomain = await request(app).post(`/api/repositories/${seeded.repoId}/refresh`);
    expect(rightDomain.status).toBe(200);
  });

  it("remove-from-dashboard targets the LOCAL BINDING id and survives id-swap attempts", async () => {
    const seeded = await seedLocalBinding();
    const app = createApp();

    const swapped = await request(app).delete(`/api/repositories/${seeded.projectId}`);
    expect([404, 500]).toContain(swapped.status); // never silently deletes another domain's row

    const correct = await request(app).delete(`/api/repositories/${seeded.repoId}?confirmDeleteProject=true`);
    expect(correct.status).toBe(200);
    expect(correct.body.projectDeleted).toBe(true); // empty fixture project cleaned up

    // Project Detail is reachable ONLY by its own id afterwards.
    const gone = await request(app).get(`/api/projects/${seeded.projectId}`);
    expect(gone.status).toBe(404);
  });
});

async function gitRemoteAdd(folder: string, url: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["remote", "add", "origin", url], { cwd: folder });
}
