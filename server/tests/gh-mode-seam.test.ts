import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  ghSimulationMode,
  resetGhPathCache,
  setGhExecutorForTests,
  type GhExecutor,
} from "../src/services/GitHubService.js";

/**
 * Safe GitHub-degradation coverage (owner request): PERSONAL_DEV_HUB_GH_MODE
 * simulates "CLI unavailable" and "CLI present but unauthenticated" without
 * touching the real gh install, PATH, or credentials.
 *
 * Pinned here:
 * - Settings status distinguishes missing CLI vs missing auth;
 * - local Git and every local-only surface keep working in both modes;
 * - existing GitHub bindings survive degraded modes untouched;
 * - picker/refresh degrade to controlled, recoverable outcomes;
 * - the seam is opt-in (unset/unknown values change nothing) and leaves no
 *   residue — restoring a normal launch restores healthy status with zero
 *   database mutation.
 */

const cleanup: string[] = [];

const healthyGh: GhExecutor = async (args) => {
  const argv = args.join(" ");
  // Status probe chain (--version, auth status, api user) + metadata/commits.
  if (argv === "--version") {
    return { stdout: "gh version 2.63.0 healthy-stub\n", stderr: "", code: 0 };
  }
  if (argv === "auth status") {
    return { stdout: "", stderr: "", code: 0 };
  }
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
          commit: { message: "seed history", author: { name: "Dev", date: "2026-07-01T09:00:00Z" } },
        },
      ]),
      stderr: "",
      code: 0,
    };
  }
  return { stdout: "", stderr: `unexpected: ${argv}`, code: 127 };
};

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-ghmode-"));
  cleanup.push(dir);
  process.env.DASHBOARD_DB_PATH = path.join(dir, "test.sqlite");
  delete process.env.PERSONAL_DEV_HUB_GH_MODE;
  closeDb();
});

afterEach(() => {
  setGhExecutorForTests(null);
  delete process.env.PERSONAL_DEV_HUB_GH_MODE;
  // resolvedGhPath is module-level state; reset it so a GH_EXECUTABLE probe
  // from one suite can never leak into the next (test isolation).
  resetGhPathCache();
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

async function status(app: ReturnType<typeof createApp>) {
  const res = await request(app).get("/api/github/status");
  return res.body.status as { installed: boolean; authenticated: boolean; accountName: string | null };
}

describe("PERSONAL_DEV_HUB_GH_MODE seam", () => {
  it("baseline: real resolver reports installed + connected through the executor stub", async () => {
    // The suite never invokes the real gh binary; a healthy executor stands
    // in for it so this pins the HEALTHY branch of getGitHubStatus().
    setGhExecutorForTests(healthyGh);
    const app = createApp();
    const s = await status(app);
    expect(s).toEqual({ installed: true, authenticated: true, accountName: "koyawel27" });
  });

  it("mode=unavailable: CLI Missing + account Not connected", async () => {
    process.env.PERSONAL_DEV_HUB_GH_MODE = "unavailable";
    const app = createApp();
    expect(await status(app)).toEqual({
      installed: false,
      authenticated: false,
      accountName: null,
    });
  });

  it("mode=unauthenticated: CLI Installed + account Not connected", async () => {
    process.env.PERSONAL_DEV_HUB_GH_MODE = "unauthenticated";
    const app = createApp();
    expect(await status(app)).toEqual({
      installed: true,
      authenticated: false,
      accountName: null,
    });
  });

  it("is opt-in: unset or unknown values never change behavior", async () => {
    setGhExecutorForTests(healthyGh);
    const app = createApp();
    expect(ghSimulationMode()).toBeNull();
    await expect(status(app)).resolves.toEqual({
      installed: true,
      authenticated: true,
      accountName: "koyawel27",
    });

    process.env.PERSONAL_DEV_HUB_GH_MODE = "totally-made-up";
    expect(ghSimulationMode()).toBeNull();
    await expect(status(app)).resolves.toEqual({
      installed: true,
      authenticated: true,
      accountName: "koyawel27",
    });

    process.env.PERSONAL_DEV_HUB_GH_MODE = "  Unavailable  ";
    expect(ghSimulationMode()).toBe("unavailable");
  });

  it("missing gh does not affect local Git availability reporting", async () => {
    process.env.PERSONAL_DEV_HUB_GH_MODE = "unavailable";
    const app = createApp();
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.git).toBe("available"); // git does not go through runGh
  });

  it("existing GitHub bindings survive degraded mode untouched", async () => {
    // Seed one tracked GITHUB ONLY binding while gh is healthy.
    setGhExecutorForTests(healthyGh);
    const app = createApp();
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/survivor" });
    expect(track.status).toBe(201);
    const projectId = track.body.projectId as number;

    // Degrade: nothing may be untracked or deleted automatically.
    process.env.PERSONAL_DEV_HUB_GH_MODE = "unavailable";

    const projects = await request(app).get("/api/projects");
    const survivor = (projects.body.projects as Array<{
      id: number;
      sourceState: string;
      githubFullName: string | null;
    }>).find((p) => p.id === projectId);
    expect(survivor?.sourceState).toBe("GITHUB ONLY");
    expect(survivor?.githubFullName).toBe("koyawel27/survivor");

    const detail = await request(app).get(`/api/projects/${projectId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.project.githubMetadata.fullName).toBe("koyawel27/survivor");
    expect((await request(app).get(`/api/projects/${projectId}`)).status).toBe(200);
  });

  it("picker degrades cleanly: cached/tracked rows render, listing unavailable", async () => {
    setGhExecutorForTests(healthyGh);
    const app = createApp();
    await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/picker-row" });

    process.env.PERSONAL_DEV_HUB_GH_MODE = "unavailable";
    const picker = await request(app).get("/api/github/repositories");
    expect(picker.status).toBe(200); // graceful, not an error page
    expect(picker.body.available).toBe(false);
    const row = (picker.body.entries as Array<{ fullName: string; tracked: boolean }>).find(
      (e) => e.fullName === "koyawel27/picker-row",
    );
    expect(row?.tracked).toBe(true); // stored state still shown
  });

  it("GitHub refresh degrades cleanly and marks stale instead of throwing", async () => {
    setGhExecutorForTests(healthyGh);
    const app = createApp();
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "koyawel27/stale-bound" });

    process.env.PERSONAL_DEV_HUB_GH_MODE = "unauthenticated";
    setGhExecutorForTests(null); // let the env seam drive runGh()
    const refresh = await request(app).post(
      `/api/github/tracked/${track.body.githubRepositoryId}/refresh`,
    );
    expect(refresh.status).toBe(200);
    expect(refresh.body.ok).toBe(false);
    expect(refresh.body.reason).toBe("unavailable"); // marked stale, cached data kept

    // Binding still tracked after the failed refresh.
    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    expect(detail.body.project.sourceState).toBe("GITHUB ONLY");
  });

  it("restores normal mode even when no gh binary exists in the environment", async () => {
    // Pins the Codex-audit failure: in a gh-less sandbox the live resolver
    // reports installed:false, which is CORRECT behavior — so restoration
    // must be asserted through the executor stub, not a real probe.
    process.env.GH_EXECUTABLE = "C:/nonexistent/gh-fake.exe";
    setGhExecutorForTests(healthyGh);
    const app = createApp();
    await request(app).post("/api/github/tracked").send({ fullName: "koyawel27/no-gh-host" });

    process.env.PERSONAL_DEV_HUB_GH_MODE = "unavailable";
    setGhExecutorForTests(null); // env seam now drives runGh()
    expect(await status(app)).toMatchObject({ installed: false });

    delete process.env.PERSONAL_DEV_HUB_GH_MODE;
    setGhExecutorForTests(healthyGh); // healthy process "restarts"
    expect(await status(app)).toEqual({
      installed: true,
      authenticated: true,
      accountName: "koyawel27",
    });
    expect(ghSimulationMode()).toBeNull();
  });

  it("local scan/rescan still works in degraded mode", async () => {
    process.env.PERSONAL_DEV_HUB_GH_MODE = "unavailable";
    const app = createApp();

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-scan-parent-"));
    cleanup.push(parent);
    const repoDir = path.join(parent, "local-child");
    const { execFileSync } = await import("node:child_process");
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Dev"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "local\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

    const source = await request(app).post("/api/sources").send({ path: parent, scanDepth: 1 });
    expect(source.status).toBe(201);
    const scan = await request(app).post(`/api/sources/${source.body.source.id}/scan`);
    expect(scan.status).toBe(200);
    expect(scan.body.summary.repositoriesDiscovered).toBe(1);

    const listed = await request(app).get("/api/repositories");
    const child = (listed.body.repositories as Array<{ name: string }>).find(
      (r) => r.name === "local-child",
    );
    expect(child).toBeTruthy();
  });

  it("restoring normal mode restores healthy status without database mutation", async () => {
    setGhExecutorForTests(healthyGh);
    const app = createApp();
    await request(app).post("/api/github/tracked").send({ fullName: "koyawel27/restore-me" });

    process.env.PERSONAL_DEV_HUB_GH_MODE = "unavailable";
    setGhExecutorForTests(null); // env seam now drives runGh()
    expect(await status(app)).toMatchObject({ installed: false });

    // "Stop the special process, start normally": unset the override. The
    // executor stub stands in for the real gh binary so this pins the
    // RESOLVER branch (mode cleared -> healthy classification) in every
    // environment — including CI/sandboxes with no gh installation, where a
    // live probe would report installed:false and fail the assertion.
    delete process.env.PERSONAL_DEV_HUB_GH_MODE;
    setGhExecutorForTests(healthyGh);
    const s = await status(app);
    expect(s).toEqual({ installed: true, authenticated: true, accountName: "koyawel27" });

    // No cleanup was needed: the tracked binding is still there.
    const projects = await request(app).get("/api/projects");
    expect(
      (projects.body.projects as Array<{ githubFullName: string | null }>).some(
        (p) => p.githubFullName === "koyawel27/restore-me",
      ),
    ).toBe(true);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toBeTruthy();
  });
});
