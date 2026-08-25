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
import { createGitRepo, useTempDb } from "./helpers.js";

/**
 * Q1 invariant regression coverage for LOCAL binding removal ("Remove from
 * dashboard"). Pins the owner-approved lifecycle: the SAME final-binding
 * rules as GitHub untrack, honest source-state serialization for every
 * binding combination, discovery events as non-meaningful bookkeeping,
 * scan-location decoupling, and idempotent ghost repair (migration 007).
 * The filesystem and GitHub are never touched by any of these flows.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

const ghStub: GhExecutor = async (args) => {
  const argv = args.join(" ");
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
  return { stdout: "[]", stderr: "", code: 0 };
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

// --- direct seeds (deterministic shapes that do not depend on git) ---------

function seedProject(
  name: string,
  meta: { status?: string; type?: string; note?: string; portfolio?: boolean } = {},
): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("INSERT INTO projects (name, project_status, project_type, project_note, include_in_portfolio, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(name, meta.status ?? null, meta.type ?? null, meta.note ?? null, meta.portfolio ? 1 : 0, now, now);
  return Number(result.lastInsertRowid);
}

function seedLocalBinding(projectId: number, localPath: string): number {
  const name = path.basename(localPath);
  const result = getDb()
    .prepare(
      `INSERT INTO local_repositories
         (source_id, project_id, name, local_path, canonical_path, discovery_type, created_at)
       VALUES (NULL, ?, ?, ?, ?, 'manual', ?)`,
    )
    .run(projectId, name, localPath, localPath.toLowerCase(), new Date().toISOString());
  return Number(result.lastInsertRowid);
}

/** The exact ghost shape found in the live owner database. */
function seedDiscoveredEvent(projectId: number): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO activity_events
         (project_id, local_repository_id, event_type, summary, occurred_at, source, fingerprint, metadata_json)
       VALUES (?, NULL, 'repository_discovered', 'Repository discovered', ?, 'scan', ?, '{}')`,
    )
    .run(projectId, now, `p${projectId}:seed:${Date.now()}:${Math.random()}`);
}

function seedGithubBinding(projectId: number, full_name: string): number {
  const [owner, name] = full_name.split("/");
  const result = getDb()
    .prepare(
      `INSERT INTO github_repositories
         (owner, name, full_name, owner_norm, name_norm, html_url, last_refreshed_at, project_id, tracked_at)
       VALUES (?, ?, ?, lower(?), lower(?), ?, ?, ?, ?)`,
    )
    .run(owner, name, full_name, owner, name, `https://github.com/${full_name}`, new Date().toISOString(), projectId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

async function projectState(projectId: number): Promise<string | null> {
  const res = await request(app).get(`/api/projects/${projectId}`);
  if (res.status === 404) return null;
  return res.body.project.sourceState as string;
}

// ---------------------------------------------------------------------------

describe("final local-binding removal lifecycle (Q1)", () => {
  it("empty LOCAL ONLY project (only a Discovered event) auto-deletes; folder untouched", async () => {
    const folder = path.join(cleanup[0], "ghost-fixture");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "keep.txt"), "real files stay");

    const projectId = seedProject("disposable-scan");
    const bindingId = seedLocalBinding(projectId, folder);
    seedDiscoveredEvent(projectId);

    // Pre-fix this exact shape survived as a "GITHUB ONLY" ghost forever.
    // With its only local binding still present it is honestly LOCAL ONLY.
    expect(await projectState(projectId)).toBe("LOCAL ONLY");

    const res = await request(app).delete(`/api/repositories/${bindingId}`);
    expect(res.status).toBe(200);
    expect(res.body.projectDeleted).toBe(true);

    // Project + its routine bookkeeping event are gone; disk untouched.
    expect((await request(app).get(`/api/projects/${projectId}`)).status).toBe(404);
    const events = getDb()
      .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE project_id = ?")
      .get(projectId) as { n: number };
    expect(events.n).toBe(0);
    expect(fs.existsSync(path.join(folder, "keep.txt"))).toBe(true);
  });

  it("LOCAL + GITHUB -> remove local binding leaves GITHUB ONLY project intact", async () => {
    const projectId = seedProject("dual-source");
    const bindingId = seedLocalBinding(projectId, "C:/tmp/dual-source");
    const ghId = seedGithubBinding(projectId, "koyawel27/dual-source");
    expect(await projectState(projectId)).toBe("LOCAL + GITHUB");

    const res = await request(app).delete(`/api/repositories/${bindingId}`);
    expect(res.status).toBe(200);
    expect(res.body.projectDeleted).toBe(false);

    expect(await projectState(projectId)).toBe("GITHUB ONLY");
    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.body.project.githubMetadata.fullName).toBe("koyawel27/dual-source");
    // The GitHub binding itself is untouched.
    const gh = getDb()
      .prepare("SELECT project_id FROM github_repositories WHERE id = ?")
      .get(ghId) as { project_id: number };
    expect(gh.project_id).toBe(projectId);
  });

  it("LOCAL ONLY with meaningful metadata refuses, stays fully intact, confirmed delete works", async () => {
    const projectId = seedProject("curated-local");
    const bindingId = seedLocalBinding(projectId, "C:/tmp/curated-local");
    getDb()
      .prepare("UPDATE projects SET project_note = ? WHERE id = ?")
      .run("owner-written note", projectId);

    const refused = await request(app).delete(`/api/repositories/${bindingId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PROJECT_HAS_NO_SOURCES");

    // Refusal is transactional: the BINDING SURVIVED (nothing was removed),
    // so a declined client-side confirmation leaves everything unchanged.
    const listed = await request(app).get("/api/repositories");
    expect(
      (listed.body.repositories as Array<{ id: number }>).some((r) => r.id === bindingId),
    ).toBe(true);
    expect(await projectState(projectId)).toBe("LOCAL ONLY");

    const confirmed = await request(app).delete(
      `/api/repositories/${bindingId}?confirmDeleteProject=true`,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.projectDeleted).toBe(true);
    expect((await request(app).get(`/api/projects/${projectId}`)).status).toBe(404);
  });

  it("LOCAL ONLY portfolio project follows the same confirmation ladder", async () => {
    const projectId = seedProject("portfolio-local", { portfolio: true });
    const bindingId = seedLocalBinding(projectId, "C:/tmp/portfolio-local");

    const refused = await request(app).delete(`/api/repositories/${bindingId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PROJECT_HAS_NO_SOURCES");

    const confirmed = await request(app).delete(
      `/api/repositories/${bindingId}?confirmDeleteProject=true`,
    );
    expect(confirmed.body.projectDeleted).toBe(true);
    const portfolio = await request(app).get("/api/portfolio");
    expect(
      (portfolio.body.projects as Array<{ id: number }>).some((p) => p.id === projectId),
    ).toBe(false);
  });

  it("removing a NON-final local binding never evaluates the project for deletion", async () => {
    const projectId = seedProject("two-copies");
    const first = seedLocalBinding(projectId, "C:/tmp/two-copies-a");
    seedLocalBinding(projectId, "C:/tmp/two-copies-b");
    seedDiscoveredEvent(projectId);

    const res = await request(app).delete(`/api/repositories/${first}`);
    expect(res.status).toBe(200);
    expect(res.body.projectDeleted).toBe(false);
    expect(await projectState(projectId)).toBe("LOCAL ONLY");
  });

  it("unknown binding id stays a safe 404", async () => {
    const res = await request(app).delete("/api/repositories/999999");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REPOSITORY_NOT_FOUND");
  });
});

describe("source-state serialization matrix (explicit BOTH-bindings test)", () => {
  it("0 local + 0 github serializes NO SOURCE, never GITHUB ONLY", async () => {
    const projectId = seedProject("matrix-none");
    seedDiscoveredEvent(projectId);
    expect(await projectState(projectId)).toBe("NO SOURCE");
  });

  it("0 local + 1 github serializes GITHUB ONLY", async () => {
    const projectId = seedProject("matrix-gh");
    seedGithubBinding(projectId, "koyawel27/matrix-gh");
    expect(await projectState(projectId)).toBe("GITHUB ONLY");
  });

  it("1 local + 0 github serializes LOCAL ONLY", async () => {
    const projectId = seedProject("matrix-local");
    seedLocalBinding(projectId, "C:/tmp/matrix-local");
    expect(await projectState(projectId)).toBe("LOCAL ONLY");
  });

  it("1 local + 1 github serializes LOCAL + GITHUB", async () => {
    const projectId = seedProject("matrix-both");
    seedLocalBinding(projectId, "C:/tmp/matrix-both");
    seedGithubBinding(projectId, "koyawel27/matrix-both");
    expect(await projectState(projectId)).toBe("LOCAL + GITHUB");
  });
});

describe("scan locations are independent of project lifecycle", () => {
  it("deleting a scan-location config does NOT untrack its discovered projects", async () => {
    // Real git fixture: a full scan runs inspectRepository() on candidates,
    // so a fake .git directory would not survive discovery. createGitRepo()
    // builds its own temp dir; move it under our scan parent.
    const parent = path.join(cleanup[0], "scan-parent");
    fs.mkdirSync(parent, { recursive: true });
    const repoDir = path.join(parent, "scanned-child");
    const repoPath = await createGitRepo();
    fs.renameSync(repoPath, repoDir);

    const created = await request(app)
      .post("/api/sources")
      .send({ path: parent, scanDepth: 1 });
    expect(created.status).toBe(201);
    const sourceId = created.body.source.id as number;

    const scanned = await request(app).post(`/api/sources/${sourceId}/scan`);
    expect(scanned.body.summary.repositoriesDiscovered).toBe(1);

    const removed = await request(app).delete(`/api/sources/${sourceId}`);
    expect(removed.status).toBe(200);

    // The discovered binding + its project both survive, now source-less.
    const listed = await request(app).get("/api/repositories");
    const child = (listed.body.repositories as Array<{
      name: string;
      sourceId: number | null;
      projectId: number;
    }>).find((r) => r.name === "scanned-child");
    expect(child).toBeTruthy();
    expect(child!.sourceId).toBeNull();
    expect(await projectState(child!.projectId)).toBe("LOCAL ONLY");
    expect(fs.existsSync(path.join(repoDir, ".git"))).toBe(true);
  });
});

describe("migration 007: idempotent zero-binding ghost repair", () => {
  function reapplyRepair(): void {
    closeDb();
    getDb()
      .prepare("DELETE FROM schema_migrations WHERE name = '007_repair_zero_binding_ghosts'")
      .run();
    closeDb();
    getDb(); // reopening re-runs migrate(), applying 007 again
  }

  function countByName(name: string): number {
    return (
      getDb().prepare("SELECT COUNT(*) AS n FROM projects WHERE name = ?").get(name) as {
        n: number;
      }
    ).n;
  }

  it("deletes provably empty ghosts, retains meaningful ones, and is idempotent", async () => {
    // Ghost A: the live defect shape — zero bindings, only a Discovered event.
    const ghostA = seedProject("fixture-ghost-empty");
    seedDiscoveredEvent(ghostA);
    // Retained B: zero bindings BUT meaningful user metadata.
    seedProject("fixture-ghost-curated", { note: "historical value" });
    // Untouched neighbours: healthy single-source projects.
    const healthyLocal = seedProject("fixture-local");
    seedLocalBinding(healthyLocal, "C:/tmp/fixture-local");
    const healthyGh = seedProject("fixture-github");
    seedGithubBinding(healthyGh, "koyawel27/fixture-github");

    reapplyRepair();
    // Second pass proves idempotency (no-op when nothing qualifies).
    reapplyRepair();

    expect(countByName("fixture-ghost-empty")).toBe(0);
    const ghostEvents = getDb()
      .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE project_id = ?")
      .get(ghostA) as { n: number };
    expect(ghostEvents.n).toBe(0);

    expect(countByName("fixture-ghost-curated")).toBe(1);
    const retained = getDb()
      .prepare("SELECT project_note FROM projects WHERE name = 'fixture-ghost-curated'")
      .get() as { project_note: string };
    expect(retained.project_note).toBe("historical value");

    expect(countByName("fixture-local")).toBe(1);
    expect(countByName("fixture-github")).toBe(1);
  });
});
