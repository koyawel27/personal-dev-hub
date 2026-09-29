import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { listSourceHealth } from "../src/services/SourceHealthService.js";
import { useTempDb } from "./helpers.js";

/**
 * V1.3 M4 Source Health: attention read model, locked health precedence,
 * and Git-process-free / no-mutation guarantees.
 */

const cleanup: string[] = [];

function insertBinding(opts: {
  name: string;
  localPath: string;
  projectId: number | null;
  isPrimary?: boolean;
  lastHealthState?: string | null;
  lastHealthCheckedAt?: string | null;
}): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO local_repositories
         (source_id, name, local_path, canonical_path, discovery_type, created_at,
          project_id, is_primary, last_health_state, last_health_checked_at)
       VALUES (NULL, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.name,
      opts.localPath,
      opts.localPath.toLowerCase(),
      new Date().toISOString(),
      opts.projectId,
      opts.isPrimary ? 1 : 0,
      opts.lastHealthState ?? null,
      opts.lastHealthCheckedAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

function insertProject(name: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)`,
    )
    .run(name, now, now);
  return Number(result.lastInsertRowid);
}

function activityCount(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM activity_events").get() as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  const dbPath = useTempDb();
  cleanup.push(path.dirname(dbPath));
  getDb();
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("SourceHealthService (V1.3 M4)", () => {
  it("excludes OK, includes PATH_MISSING / UNSCANNED / NOT_A_GIT_REPO, and counts correctly", () => {
    const projectId = insertProject("Alpha");
    const missingDir = path.join(path.dirname(process.env.DASHBOARD_DB_PATH!), "gone-folder");
    const existingDir = path.join(path.dirname(process.env.DASHBOARD_DB_PATH!), "exists");
    fs.mkdirSync(existingDir, { recursive: true });

    // 1. OK (path exists + cached OK) → excluded from items
    insertBinding({
      name: "ok-binding",
      localPath: existingDir,
      projectId,
      isPrimary: true,
      lastHealthState: "OK",
      lastHealthCheckedAt: "2026-03-01T00:00:00.000Z",
    });
    // 2. PATH_MISSING → included
    insertBinding({
      name: "missing-binding",
      localPath: missingDir,
      projectId,
      lastHealthState: "OK", // cached OK must NOT override missing path
      lastHealthCheckedAt: "2026-03-01T00:00:00.000Z",
    });
    // 3. UNSCANNED (path exists, no cache) → included
    const unscannedPath = path.join(existingDir, "unscanned-child");
    fs.mkdirSync(unscannedPath, { recursive: true });
    insertBinding({
      name: "unscanned-binding",
      localPath: unscannedPath,
      projectId,
      lastHealthState: null,
    });
    // 4. NOT_A_GIT_REPO → included
    const notGitPath = path.join(existingDir, "not-git-child");
    fs.mkdirSync(notGitPath, { recursive: true });
    insertBinding({
      name: "not-git-binding",
      localPath: notGitPath,
      projectId,
      lastHealthState: "NOT_A_GIT_REPO",
      lastHealthCheckedAt: "2026-03-02T00:00:00.000Z",
    });

    const result = listSourceHealth();
    expect(result.totalLocalBindings).toBe(4);
    expect(result.attentionCount).toBe(3);
    expect(result.pathMissingCount).toBe(1);
    expect(result.notGitRepoCount).toBe(1);
    expect(result.unscannedCount).toBe(1);

    const byName = new Map(result.items.map((i) => [i.bindingName, i]));
    expect(byName.has("ok-binding")).toBe(false);
    expect(byName.get("missing-binding")?.health.state).toBe("PATH_MISSING");
    expect(byName.get("unscanned-binding")?.health.state).toBe("UNSCANNED");
    expect(byName.get("not-git-binding")?.health.state).toBe("NOT_A_GIT_REPO");
  });

  it("keeps locked precedence: missing path beats cached OK/NOT_A_GIT_REPO", () => {
    const projectId = insertProject("Beta");
    const gone = path.join(path.dirname(process.env.DASHBOARD_DB_PATH!), "nope");
    const bindingId = insertBinding({
      name: "precedence",
      localPath: gone,
      projectId,
      lastHealthState: "OK",
      lastHealthCheckedAt: "2026-03-01T00:00:00.000Z",
    });

    const result = listSourceHealth();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].bindingId).toBe(bindingId);
    expect(result.items[0].health.state).toBe("PATH_MISSING");
    expect(result.items[0].health.checkedAt).toBeNull();
  });

  it("lists multiple bindings from one project independently with primary identity", () => {
    const projectId = insertProject("Gamma");
    const dir = path.join(path.dirname(process.env.DASHBOARD_DB_PATH!), "shared");
    fs.mkdirSync(dir, { recursive: true });
    const primary = insertBinding({
      name: "primary-missing",
      localPath: path.join(dir, "gone-a"),
      projectId,
      isPrimary: true,
    });
    const secondary = insertBinding({
      name: "secondary-unscanned",
      localPath: dir,
      projectId,
      isPrimary: false,
      lastHealthState: null,
    });

    const result = listSourceHealth();
    expect(result.attentionCount).toBe(2);
    const byId = new Map(result.items.map((i) => [i.bindingId, i]));
    expect(byId.get(primary)?.isPrimary).toBe(true);
    expect(byId.get(secondary)?.isPrimary).toBe(false);
    expect(byId.get(primary)?.projectName).toBe("Gamma");
    expect(byId.get(secondary)?.projectName).toBe("Gamma");
  });

  it("returns a calm zero-attention result when everything is OK", () => {
    const projectId = insertProject("Delta");
    const dir = path.join(path.dirname(process.env.DASHBOARD_DB_PATH!), "ok-dir");
    fs.mkdirSync(dir, { recursive: true });
    insertBinding({
      name: "healthy",
      localPath: dir,
      projectId,
      isPrimary: true,
      lastHealthState: "OK",
      lastHealthCheckedAt: "2026-03-01T00:00:00.000Z",
    });

    const result = listSourceHealth();
    expect(result.totalLocalBindings).toBe(1);
    expect(result.attentionCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.pathMissingCount).toBe(0);
    expect(result.notGitRepoCount).toBe(0);
    expect(result.unscannedCount).toBe(0);
  });
});

describe("GET /api/maintenance/source-health (V1.3 M4)", () => {
  it("returns attention list + counts without Git, refresh, or Activity writes", async () => {
    const projectId = insertProject("ApiProject");
    const dir = path.join(path.dirname(process.env.DASHBOARD_DB_PATH!), "api-dir");
    fs.mkdirSync(dir, { recursive: true });
    insertBinding({
      name: "api-missing",
      localPath: path.join(dir, "gone"),
      projectId,
      isPrimary: true,
    });
    insertBinding({
      name: "api-ok",
      localPath: dir,
      projectId,
      lastHealthState: "OK",
      lastHealthCheckedAt: "2026-03-01T00:00:00.000Z",
    });

    const activityBefore = activityCount();
    const healthBefore = getDb()
      .prepare(
        "SELECT last_health_state, last_health_checked_at FROM local_repositories WHERE name = 'api-missing'",
      )
      .get();

    const runGit = await import("../src/lib/gitRunner.js");
    const gitSpy = vi.spyOn(runGit, "runGit");
    const resolveSpy = vi.spyOn(runGit, "resolveGitPath");

    const app = createApp();
    const res = await request(app).get("/api/maintenance/source-health");

    expect(res.status).toBe(200);
    expect(res.body.attentionCount).toBe(1);
    expect(res.body.pathMissingCount).toBe(1);
    expect(res.body.totalLocalBindings).toBe(2);
    expect(res.body.items[0].bindingName).toBe("api-missing");
    expect(res.body.items[0].projectName).toBe("ApiProject");
    expect(res.body.items[0].isPrimary).toBe(true);

    // No Git process / git runner use.
    expect(gitSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();

    // No health-cache mutation.
    const healthAfter = getDb()
      .prepare(
        "SELECT last_health_state, last_health_checked_at FROM local_repositories WHERE name = 'api-missing'",
      )
      .get();
    expect(healthAfter).toEqual(healthBefore);

    // No Activity write.
    expect(activityCount()).toBe(activityBefore);
  });
});
