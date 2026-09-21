import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, openDatabase } from "../src/db/client.js";
import {
  addManualRepository,
  refreshRepository,
} from "../src/services/RepositoryService.js";
import {
  deriveSourceState,
  getProjectDetail,
} from "../src/services/ProjectService.js";
import { createGitRepo, makeTempDir } from "./helpers.js";

/**
 * Release-level database QA (V1.2 M6-C1). Two focused regressions that the
 * lower-level migration tests do not prove together:
 *
 * 1. A pristine database created through the REAL openDatabase() path is
 *    coherent and immediately usable: full migration chain applied exactly
 *    once, V1.2 local-binding shape present, FK/integrity clean, and the
 *    normal add-inspect-read workflow works on it.
 * 2. An accepted V1.1-final database (built from the actual schema.sql plus
 *    the repository's own migration SQL through 007 — never hand-invented
 *    columns) upgrades to V1.2 by applying ONLY 008/009, preserving all data
 *    and assigning primaries/health per the migration contracts.
 */

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db");
const MIGRATIONS_DIR = path.join(here, "migrations");

const cleanupDirs: string[] = [];
const openHandles: Array<{ close: () => void }> = [];
let previousDbPath: string | undefined = process.env.DASHBOARD_DB_PATH;

afterAll(() => {
  for (const handle of openHandles.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed
    }
  }
  closeDb();
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort on Windows lock timing
    }
  }
  if (previousDbPath === undefined) {
    delete process.env.DASHBOARD_DB_PATH;
  } else {
    process.env.DASHBOARD_DB_PATH = previousDbPath;
  }
});

/** The actual migration chain derived from the repository, not from memory. */
function expectedMigrationNames(): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return ["001_initial", ...files.map((file) => path.basename(file, ".sql"))];
}

function trackDb(dirPrefix: string): { dbPath: string; db: DatabaseSync } {
  const dir = makeTempDir(dirPrefix);
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "release.sqlite");
  process.env.DASHBOARD_DB_PATH = dbPath;
  closeDb();
  const db = openDatabase(dbPath) as DatabaseSync;
  openHandles.push(db as unknown as { close: () => void });
  return { dbPath, db };
}

function assertMigrationChain(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM schema_migrations ORDER BY id ASC")
    .all() as { name: string }[];
  expect(rows.map((row) => row.name)).toEqual(expectedMigrationNames());
  // Singletons: no migration name may appear twice.
  const dupes = db
    .prepare(
      "SELECT name FROM schema_migrations GROUP BY name HAVING COUNT(*) > 1",
    )
    .all();
  expect(dupes).toEqual([]);
}

function assertDatabaseHealth(db: DatabaseSync): void {
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const integrity = db
    .prepare("PRAGMA integrity_check")
    .get() as { integrity_check: string };
  expect(integrity.integrity_check).toBe("ok");
}

function assertV12BindingShape(db: DatabaseSync): void {
  const columns = (
    db.prepare("PRAGMA table_info(local_repositories)").all() as {
      name: string;
    }[]
  ).map((column) => column.name);
  expect(columns).toContain("project_id");
  expect(columns).toContain("is_primary");
  expect(columns).toContain("last_health_state");
  expect(columns).toContain("last_health_checked_at");

  // Partial unique index: at most one explicit primary per Project.
  const primaryIndex = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_repo_project_primary'",
    )
    .get() as { sql: string } | undefined;
  expect(primaryIndex?.sql).toContain("is_primary");
  expect(primaryIndex?.sql).toContain("WHERE");

  // 009 storage constraint: only NULL/'OK'/'NOT_A_GIT_REPO' are storable.
  const tableSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_repositories'",
      )
      .get() as { sql: string }
  ).sql;
  expect(tableSql).toContain("NOT_A_GIT_REPO");
  expect(tableSql).toContain("CHECK");
}

describe("release V1.2 database QA", () => {
  it("creates a coherent, immediately usable pristine V1.2 database", async () => {
    const { dbPath, db } = trackDb("ldd-rel-pristine-");

    // A. Migration coherence on a genuinely empty database.
    assertMigrationChain(db);

    // B. V1.2 local-binding shape from the real migration chain.
    assertV12BindingShape(db);

    // C. Database health.
    assertDatabaseHealth(db);

    // D. Smallest real workflow: manual add of a disposable Git repository
    // through the normal service path, explicit inspection, read model.
    const repoDir = await createGitRepo();
    cleanupDirs.push(repoDir);
    const added = await addManualRepository({ path: repoDir });
    expect(added.id).toBeGreaterThan(0);
    expect(added.projectId).not.toBeNull();
    expect(added.isPrimary).toBe(true);

    await refreshRepository(added.id);

    const detail = await getProjectDetail(added.projectId as number);
    expect(detail.project.sourceState).toBe("LOCAL ONLY");
    expect(detail.project.localPath).toBe(added.localPath);
    expect(detail.project.localBindings).toHaveLength(1);
    expect(detail.project.localBindings[0].id).toBe(added.id);
    expect(detail.project.localBindings[0].isPrimary).toBe(true);
    // Explicit inspection produced a cached OK verdict.
    expect(detail.project.localBindings[0].health.state).toBe("OK");
    expect(detail.project.localBindings[0].health.checkedAt).not.toBeNull();
    expect(detail.project.localBindings[0].snapshot?.branch).toBe("main");
    expect(deriveSourceState(added.projectId as number)).toBe("LOCAL ONLY");

    // E. Reopen: same data, same ids, migration records remain singletons.
    closeDb();
    const reopened = openDatabase(dbPath) as DatabaseSync;
    openHandles.push(reopened as unknown as { close: () => void });

    assertMigrationChain(reopened);
    const binding = reopened
      .prepare(
        "SELECT id, project_id, is_primary FROM local_repositories WHERE id = ?",
      )
      .get(added.id) as { id: number; project_id: number; is_primary: number };
    expect(binding.id).toBe(added.id);
    expect(binding.project_id).toBe(added.projectId);
    expect(binding.is_primary).toBe(1);
    assertDatabaseHealth(reopened);
  });

  it("upgrades an accepted V1.1-final database to V1.2 preserving all data", async () => {
    // ---- Fixture: V1.1-final state, built ONLY from the repository's real
    // schema.sql plus the actual 002–007 migration SQL (never invented
    // columns), stopping before 008/009 exactly like a real owner database.
    const dir = makeTempDir("ldd-rel-upgrade-");
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "v11.sqlite");
    const fixture = new DatabaseSync(dbPath);
    openHandles.push(fixture as unknown as { close: () => void });

    const NOW = "2026-08-20T10:00:00.000Z";
    const SCANNED_AT = "2026-08-20T11:00:00.000Z";

    fixture.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
    const v11Chain = [
      "002_project_metadata",
      "003_app_settings",
      "004_projects_core",
      "005_github_bindings",
      "006_project_activity",
      "007_repair_zero_binding_ghosts",
    ];
    for (const name of v11Chain) {
      fixture.exec(
        fs.readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), "utf8"),
      );
    }
    for (const name of ["001_initial", ...v11Chain]) {
      fixture
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(name, NOW);
    }
    expect(
      (fixture.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
        n: number;
      }).n,
    ).toBe(7);

    // Binding paths are REAL existing temp dirs so a cached health verdict is
    // not shadowed by a derived PATH_MISSING at read time.
    const alphaDir = makeTempDir("ldd-rel-alpha-");
    const alphaCopyDir = makeTempDir("ldd-rel-alphacopy-");
    cleanupDirs.push(alphaDir, alphaCopyDir);

    // ---- Seed a minimal but meaningful V1.1 population ---------------------
    // Project A (id 1): two local bindings (id 1 scanned, id 2 never
    // scanned), snapshots, commits, project-scoped activity, one tracked
    // GitHub binding. Project B (id 2): GitHub-only.
    fixture
      .prepare(
        `INSERT INTO projects
           (name, project_status, project_type, project_note,
            include_in_portfolio, portfolio_order, created_at, updated_at)
         VALUES ('alpha', 'Active', 'Personal', 'core app', 1, 2, ?, ?)`,
      )
      .run(NOW, NOW);
    fixture
      .prepare(
        `INSERT INTO local_repositories
           (source_id, name, local_path, canonical_path, discovery_type,
            created_at, last_scanned_at, project_id)
         VALUES (NULL, 'alpha', ?, ?, 'manual', ?, ?, 1)`,
      )
      .run(alphaDir, alphaDir.toLowerCase(), NOW, SCANNED_AT);
    fixture
      .prepare(
        `INSERT INTO local_repositories
           (source_id, name, local_path, canonical_path, discovery_type,
            created_at, last_scanned_at, project_id)
         VALUES (NULL, 'alpha-copy', ?, ?, 'scanned', ?, NULL, 1)`,
      )
      .run(alphaCopyDir, alphaCopyDir.toLowerCase(), NOW);
    fixture
      .prepare(
        `INSERT INTO repository_snapshots
           (local_repository_id, branch, head_commit_sha, is_dirty,
            modified_count, staged_count, untracked_count, upstream_ref,
            ahead_count, behind_count, captured_at)
         VALUES (1, 'main', 'aaa111', 0, 0, 0, 0, NULL, NULL, NULL, ?)`,
      )
      .run(NOW);
    fixture
      .prepare(
        `INSERT INTO repository_snapshots
           (local_repository_id, branch, head_commit_sha, is_dirty,
            modified_count, staged_count, untracked_count, upstream_ref,
            ahead_count, behind_count, captured_at)
         VALUES (2, 'develop', 'bbb222', 0, 1, 0, 0, NULL, NULL, NULL, ?)`,
      )
      .run(NOW);
    fixture
      .prepare(
        `INSERT INTO commits
           (local_repository_id, commit_sha, subject, author_name,
            committed_at, first_seen_at)
         VALUES (1, 'sha_alpha_1', 'alpha initial', 'Dev', ?, ?)`,
      )
      .run(NOW, NOW);
    fixture
      .prepare(
        `INSERT INTO commits
           (local_repository_id, commit_sha, subject, author_name,
            committed_at, first_seen_at)
         VALUES (2, 'sha_alpha_2', 'alpha-copy initial', 'Dev', ?, ?)`,
      )
      .run(NOW, NOW);
    fixture
      .prepare(
        `INSERT INTO activity_events
           (project_id, local_repository_id, event_type, summary,
            occurred_at, source, fingerprint, metadata_json)
         VALUES (1, 1, 'commit_observed', 'alpha initial', ?, 'scan',
                 'p1:1:commit:sha_alpha_1', '{}')`,
      )
      .run(NOW);
    fixture
      .prepare(
        `INSERT INTO activity_events
           (project_id, local_repository_id, event_type, summary,
            occurred_at, source, fingerprint, metadata_json)
         VALUES (1, 2, 'commit_observed', 'alpha-copy initial', ?, 'scan',
                 'p1:2:commit:sha_alpha_2', '{}')`,
      )
      .run(NOW);
    fixture
      .prepare(
        `INSERT INTO github_repositories
           (owner, name, full_name, visibility, default_branch, html_url,
            last_pushed_at, last_refreshed_at, project_id, tracked_at,
            archived, fork, description, language, owner_norm, name_norm)
         VALUES ('OctoCat', 'alpha', 'OctoCat/alpha', 'private', 'main',
                 'https://github.com/OctoCat/alpha', '2026-08-19T00:00:00Z',
                 ?, 1, ?, 0, 0, 'alpha desc', 'TypeScript', 'octocat', 'alpha')`,
      )
      .run(NOW, NOW);
    fixture
      .prepare(
        `INSERT INTO github_commits
           (project_id, github_repository_id, commit_sha, subject,
            author_name, committed_at, fetched_at)
         VALUES (1, 1, 'gh_alpha_1', 'alpha gh commit', 'Dev', ?, ?)`,
      )
      .run(NOW, NOW);
    fixture
      .prepare(
        `INSERT INTO projects
           (name, project_status, project_type, project_note,
            include_in_portfolio, portfolio_order, created_at, updated_at)
         VALUES ('beta', NULL, 'School', NULL, 1, 5, ?, ?)`,
      )
      .run(NOW, NOW);
    fixture
      .prepare(
        `INSERT INTO github_repositories
           (owner, name, full_name, visibility, default_branch, html_url,
            last_pushed_at, last_refreshed_at, project_id, tracked_at,
            archived, fork, description, language, owner_norm, name_norm)
         VALUES ('octocat', 'beta', 'octocat/beta', 'public', 'main',
                 'https://github.com/octocat/beta', '2026-08-18T00:00:00Z',
                 ?, 2, ?, 0, 0, NULL, 'Go', 'octocat', 'beta')`,
      )
      .run(NOW, NOW);
    fixture
      .prepare(
        `INSERT INTO github_commits
           (project_id, github_repository_id, commit_sha, subject,
            author_name, committed_at, fetched_at)
         VALUES (2, 2, 'gh_beta_1', 'beta gh commit', 'Dev', ?, ?)`,
      )
      .run(NOW, NOW);

    // ---- Pre-upgrade evidence snapshot (logical persisted data) ------------
    const before = {
      projects: fixture.prepare("SELECT * FROM projects ORDER BY id").all(),
      bindings: fixture
        .prepare("SELECT * FROM local_repositories ORDER BY id")
        .all(),
      gh: fixture.prepare("SELECT * FROM github_repositories ORDER BY id").all(),
      ghCommits: fixture
        .prepare("SELECT * FROM github_commits ORDER BY id")
        .all(),
      commits: fixture.prepare("SELECT * FROM commits ORDER BY id").all(),
      snapshots: fixture
        .prepare("SELECT * FROM repository_snapshots ORDER BY id")
        .all(),
      events: fixture.prepare("SELECT * FROM activity_events ORDER BY id").all(),
    };
    fixture.close();
    // ---- Run the CURRENT upgrade path (applies only 008/009) ---------------
    process.env.DASHBOARD_DB_PATH = dbPath;
    closeDb();
    const db = openDatabase(dbPath) as DatabaseSync;
    openHandles.push(db as unknown as { close: () => void });

    assertMigrationChain(db);
    assertV12BindingShape(db);

    // A. Preservation: every seeded logical row survived. 008/009 only ADD
    // columns to local_repositories; compare the pre-existing columns.
    const stripColumns = (row: unknown, keys: string[]): Record<string, unknown> => {
      const copy = { ...(row as Record<string, unknown>) };
      for (const key of keys) delete copy[key];
      return copy;
    };
    const addedColumns = ["is_primary", "last_health_state", "last_health_checked_at"];
    const afterBindings = db
      .prepare("SELECT * FROM local_repositories ORDER BY id")
      .all()
      .map((row) => stripColumns(row, addedColumns));
    expect(afterBindings).toEqual(before.bindings);
    expect(db.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(
      before.projects,
    );
    expect(
      db.prepare("SELECT * FROM github_repositories ORDER BY id").all(),
    ).toEqual(before.gh);
    expect(
      db.prepare("SELECT * FROM github_commits ORDER BY id").all(),
    ).toEqual(before.ghCommits);
    expect(db.prepare("SELECT * FROM commits ORDER BY id").all()).toEqual(
      before.commits,
    );
    expect(
      db.prepare("SELECT * FROM repository_snapshots ORDER BY id").all(),
    ).toEqual(before.snapshots);
    expect(
      db.prepare("SELECT * FROM activity_events ORDER BY id").all(),
    ).toEqual(before.events);

    // B. Migration 008: exactly one explicit primary per project with local
    // bindings, and it is MIN(id); nothing fabricated for GitHub-only B.
    const primaries = db
      .prepare(
        "SELECT id, project_id FROM local_repositories WHERE project_id = 1 AND is_primary = 1",
      )
      .all() as Array<{ id: number; project_id: number }>;
    expect(primaries).toEqual([{ id: 1, project_id: 1 }]);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = 2",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);

    // C. Migration 009: scanned binding backfilled OK at its last_scanned_at;
    // never-scanned binding stays NULL/NULL.
    const health1 = db
      .prepare(
        "SELECT last_health_state, last_health_checked_at FROM local_repositories WHERE id = 1",
      )
      .get() as { last_health_state: string | null; last_health_checked_at: string | null };
    expect(health1.last_health_state).toBe("OK");
    expect(health1.last_health_checked_at).toBe(SCANNED_AT);
    const health2 = db
      .prepare(
        "SELECT last_health_state, last_health_checked_at FROM local_repositories WHERE id = 2",
      )
      .get() as { last_health_state: string | null; last_health_checked_at: string | null };
    expect(health2.last_health_state).toBeNull();
    expect(health2.last_health_checked_at).toBeNull();

    // D. V1.2 read model on the upgraded data.
    const detailA = await getProjectDetail(1);
    expect(detailA.project.sourceState).toBe("LOCAL + GITHUB");
    expect(detailA.project.localBindings).toHaveLength(2);
    const primaryBinding = detailA.project.localBindings.find((b) => b.isPrimary);
    expect(detailA.project.localBindings.filter((b) => b.isPrimary)).toHaveLength(1);
    expect(primaryBinding?.id).toBe(1);
    // Top-level localPath/snapshot derive from the display primary only.
    expect(detailA.project.localPath).toBe(alphaDir);
    expect(detailA.project.localPath).toBe(primaryBinding?.localPath);
    expect(detailA.project.snapshot?.branch).toBe("main");
    // Per-binding health is coherent: cached OK for the scanned binding,
    // UNSCANNED for the never-scanned one (both paths exist).
    const healthById = new Map(
      detailA.project.localBindings.map((b) => [b.id, b.health]),
    );
    expect(healthById.get(1)?.state).toBe("OK");
    expect(healthById.get(1)?.checkedAt).toBe(SCANNED_AT);
    expect(healthById.get(2)?.state).toBe("UNSCANNED");

    const detailB = await getProjectDetail(2);
    expect(detailB.project.sourceState).toBe("GITHUB ONLY");
    expect(detailB.project.localBindings).toHaveLength(0);
    expect(detailB.project.localPath).toBeNull();
    expect(deriveSourceState(2)).toBe("GITHUB ONLY");

    // E. Database health after upgrade.
    assertDatabaseHealth(db);

    // F. Idempotent reopen: 008/009 not applied twice; data unchanged.
    closeDb();
    const reopened = openDatabase(dbPath) as DatabaseSync;
    openHandles.push(reopened as unknown as { close: () => void });
    assertMigrationChain(reopened);
    const primariesAfter = reopened
      .prepare(
        "SELECT id, project_id FROM local_repositories WHERE is_primary = 1 ORDER BY id",
      )
      .all() as Array<{ id: number; project_id: number }>;
    expect(primariesAfter).toEqual([{ id: 1, project_id: 1 }]);
    const healthAfter = reopened
      .prepare(
        "SELECT last_health_state, last_health_checked_at FROM local_repositories WHERE id = 1",
      )
      .get() as { last_health_state: string | null; last_health_checked_at: string | null };
    expect(healthAfter.last_health_state).toBe("OK");
    expect(healthAfter.last_health_checked_at).toBe(SCANNED_AT);
    assertDatabaseHealth(reopened);
  });
});
