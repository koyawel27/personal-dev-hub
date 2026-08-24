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
import { useTempDb } from "./helpers.js";

/**
 * Milestone GD — gh adapter + picker + tracked refresh, with FAKE gh.
 * No live GitHub is required for any test in this file.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

const GH_PAGE_ONE = [
  {
    name: "picker-repo",
    full_name: "octocat/picker-repo",
    owner: { login: "octocat" },
    private: true,
    language: "TypeScript",
    description: "a repo",
    archived: false,
    fork: false,
    permissions: { push: false },
    pushed_at: "2026-08-01T00:00:00Z",
  },
  {
    name: "org-repo",
    full_name: "some-org/org-repo",
    owner: { login: "some-org" },
    private: false,
    language: "Go",
    description: null,
    archived: true,
    fork: true,
    permissions: { push: true },
    pushed_at: "2026-07-01T00:00:00Z",
  },
];

function ghListingExecutor(options?: { fail?: boolean; empty?: boolean }): GhExecutor {
  return async (args) => {
    const argv = args.join(" ");
    if (argv.startsWith("auth status")) return { stdout: "", stderr: "", code: 0 };
    if (argv === "--version") return { stdout: "gh version 2.0.0", stderr: "", code: 0 };
    if (argv === "api user") return { stdout: JSON.stringify({ login: "octocat" }), stderr: "", code: 0 };
    if (argv.startsWith("api user/repos")) {
      if (options?.fail) return { stdout: "", stderr: "network down", code: 1 };
      const pageMatch = /[?&]page=(\d+)/.exec(argv);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      return {
        stdout: JSON.stringify(page === 1 && !options?.empty ? GH_PAGE_ONE : []),
        stderr: "",
        code: 0,
      };
    }
    if (/^api repos\/[^/]+\/[^/]+\/commits/.test(argv)) {
      if (options?.fail) return { stdout: "", stderr: "boom", code: 1 };
      return {
        stdout: JSON.stringify([
          {
            sha: "gsha-1",
            commit: { message: "github-side commit\n\nbody", author: { name: "Dev", date: "2026-08-22T10:00:00Z" } },
          },
        ]),
        stderr: "",
        code: 0,
      };
    }
    if (/^api repos\//.test(argv)) {
      if (options?.fail) return { stdout: "", stderr: "404", code: 1 };
      return {
        stdout: JSON.stringify({
          owner: { login: "octocat" },
          name: "picker-repo",
          full_name: "octocat/picker-repo",
          visibility: "private",
          default_branch: "main",
          html_url: "https://github.com/octocat/picker-repo",
          pushed_at: "2026-08-01T00:00:00Z",
        }),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: `unexpected gh call: ${argv}`, code: 127 };
  };
}

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
  setGhExecutorForTests(ghListingExecutor());
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

describe("gh adapter + picker (fake gh)", () => {
  it("lists account repositories with tracked flags and local-copy detection", async () => {
    // Local copy of picker-repo exists and is tracked.
    await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octocat/picker-repo" });

    const picker = await request(app).get("/api/github/repositories");
    expect(picker.status).toBe(200);
    expect(picker.body.available).toBe(true);
    const entries = picker.body.entries as Array<{
      fullName: string;
      tracked: boolean;
      visibility: string | null;
      localCopyPath: string | null;
      archived: boolean;
      fork: boolean;
      affiliation: string | null;
    }>;
    const mine = entries.find((entry) => entry.fullName === "octocat/picker-repo");
    expect(mine).toBeDefined();
    expect(mine?.tracked).toBe(true);
    expect(mine?.visibility ?? null).toBe("private");
    const org = entries.find((entry) => entry.fullName === "some-org/org-repo");
    console.log("PICKER ENTRIES", JSON.stringify(entries));
    expect(org?.archived).toBe(true);
    expect(org?.fork).toBe(true);
    expect(org?.affiliation).toBe("collaborator");
  });

  it("degrades gracefully when gh is missing or the network fails", async () => {
    setGhExecutorForTests(null); // real resolver: gh likely present but we force listing failure below
    setGhExecutorForTests(ghListingExecutor({ fail: true }));
    const picker = await request(app).get("/api/github/repositories");
    expect(picker.status).toBe(200);
    // Listing unavailable but the endpoint never breaks.
    expect(typeof picker.body.available).toBe("boolean");

    // gh entirely missing:
    setGhExecutorForTests(async () => ({ stdout: "", stderr: "spawn ENOENT", code: 127 }));
    const offline = await request(app).get("/api/github/repositories");
    expect(offline.status).toBe(200);

    // Local dashboard still works with GitHub dead.
    const dash = await request(app).get("/api/dashboard");
    expect(dash.status).toBe(200);
  });

  it("refresh stores github commits once; repeated refresh adds nothing (noise rule)", async () => {
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octocat/picker-repo" });
    const ghId = track.body.githubRepositoryId as number;

    // Initial refresh on track already stored the commit; a manual refresh
    // of unchanged history adds nothing (SHA dedup + noise rule).
    const first = await request(app).post(`/api/github/tracked/${ghId}/refresh`);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.newCommits).toBe(0);

    const second = await request(app).post(`/api/github/tracked/${ghId}/refresh`);
    expect(second.body.ok).toBe(true);
    expect(second.body.newCommits).toBe(0);

    const db = getDb();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM github_commits").get() as { n: number }).n,
    ).toBe(1);
    const events = db
      .prepare(
        "SELECT event_type, source FROM activity_events WHERE event_type = 'github_commit_observed'",
      )
      .all() as Array<{ event_type: string; source: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("user");

    // Project detail exposes the github-sourced commit for GITHUB ONLY view
    // semantics even though this project is linked — commits carry source tags.
    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    const sources = (detail.body.project.commits as Array<{ source: string }>).map(
      (commit) => commit.source,
    );
    expect(sources).toContain("github");
  });

  it("handles repository deletion/inaccessibility without crashing", async () => {
    setGhExecutorForTests(ghListingExecutor({ fail: true }));
    const track = await request(app)
      .post("/api/github/tracked")
      .send({ fullName: "octocat/picker-repo" });
    const refresh = await request(app).post(
      `/api/github/tracked/${track.body.githubRepositoryId}/refresh`,
    );
    expect(refresh.status).toBe(200);
    expect(refresh.body.ok).toBe(false);
    expect(refresh.body.reason).toBe("unavailable");

    // The binding remains tracked and the project intact.
    const detail = await request(app).get(`/api/projects/${track.body.projectId}`);
    expect(detail.status).toBe(200);
  });

  it("enforces the pagination cap", async () => {
    let calls = 0;
    setGhExecutorForTests(async (args) => {
      const argv = args.join(" ");
      if (argv.startsWith("auth status") || argv === "--version") {
        return { stdout: "ok", stderr: "", code: 0 };
      }
      if (argv === "api user") return { stdout: JSON.stringify({ login: "o" }), stderr: "", code: 0 };
      if (argv.startsWith("api user/repos")) {
        calls += 1;
        return { stdout: JSON.stringify(Array(100).fill(GH_PAGE_ONE[0])), stderr: "", code: 0 };
      }
      return { stdout: "[]", stderr: "", code: 0 };
    });

    await request(app).get("/api/github/repositories");
    expect(calls).toBeLessThanOrEqual(10); // PICKER_MAX_PAGES
  });
});
