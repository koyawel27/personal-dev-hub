import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, openDatabase } from "../src/db/client.js";
import { makeTempDir } from "./helpers.js";

/**
 * V1.3 M5-B2 release compatibility QA.
 *
 * V1.3 ships ZERO new SQLite migrations and ZERO schema.sql edits relative to
 * the accepted V1.2 application tag (`personal-dev-hub-v1.2-owner-accepted`).
 * These tests prove that claim at the database layer without touching the
 * owner's real database and without network/GitHub dependencies:
 *
 * 1. The repository's migration set is exactly the accepted V1.2 chain
 *    (names and file content locked to the V1.2 set — no V1.3 migration).
 * 2. A deterministic V1.2-final fixture database opens through the real
 *    `openDatabase()` path under V1.3 with schema_migrations EXACTLY unchanged
 *    and representative domain data preserved.
 * 3. A pristine database initializes correctly through the same path.
 */

const here = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "db",
);
const MIGRATIONS_DIR = path.join(here, "migrations");

/** Accepted V1.2 migration chain (001_base + on-disk .sql files). Locked. */
const V12_MIGRATION_NAMES = [
  "001_initial",
  "002_project_metadata",
  "003_app_settings",
  "004_projects_core",
  "005_github_bindings",
  "006_project_activity",
  "007_repair_zero_binding_ghosts",
  "008_primary_local_binding",
  "009_local_binding_health",
] as const;

/**
 * Content hashes of every schema artifact at the accepted V1.2 tag.
 * Recorded once from `git rev-parse personal-dev-hub-v1.2-owner-accepted:<path>`
 * so an accidental V1.3 migration edit fails loudly in CI, not only in a
 * one-off manual Git inspection.
 */
const V12_SCHEMA_BLOB_HASHES: Record<string, string> = {
  "schema.sql": "33f6499117da45f058d497e75b9d047f761362f6",
  "migrations/002_project_metadata.sql":
    "27a47e644b330795f8f1e4009a192665d3ff8473",
  "migrations/003_app_settings.sql": "cb12b0304b4e75067f24876156b31770731f6982",
  "migrations/004_projects_core.sql": "8945069aea8fa8c2548159d4ce8d2729fe04f703",
  "migrations/005_github_bindings.sql":
    "c8d97325f37e0f7deb930d78c8719018dc5c232d",
  "migrations/006_project_activity.sql":
    "1851781b37b1ebbbd20419f6c1a42a0d541900dd",
  "migrations/007_repair_zero_binding_ghosts.sql":
    "addda406cb4db6bcf08009ba27a1cbad273076b6",
  "migrations/008_primary_local_binding.sql":
    "9d9cff03fef554ad77a8c6ae85b8ca9ce408c084",
  "migrations/009_local_binding_health.sql":
    "0a1489255e4564f32e208915e143c1216017375e",
};

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

function trackDb(dirPrefix: string, fileName: string): {
  dbPath: string;
  db: DatabaseSync;
} {
  const dir = makeTempDir(dirPrefix);
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, fileName);
  process.env.DASHBOARD_DB_PATH = dbPath;
  closeDb();
  const db = openDatabase(dbPath) as DatabaseSync;
  openHandles.push(db as unknown as { close: () => void });
  return { dbPath, db };
}

function migrationRows(
  db: DatabaseSync,
): Array<{ id: number; name: string; applied_at: string }> {
  return db
    .prepare("SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC")
    .all() as Array<{ id: number; name: string; applied_at: string }>;
}

function migrationNames(db: DatabaseSync): string[] {
  return migrationRows(db).map((row) => row.name);
}

function assertDatabaseHealth(db: DatabaseSync): void {
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const integrity = db.prepare("PRAGMA integrity_check").get() as {
    integrity_check: string;
  };
  expect(integrity.integrity_check).toBe("ok");
}

function expectedOnDiskMigrationNames(): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return files.map((file) => path.basename(file, ".sql"));
}

/**
 * Build a disposable V1.2-final fixture: real schema.sql + the repository's
 * own migration SQL through 009, then seed representative domain rows.
 * Binding paths are real existing temp dirs so cached health is not shadowed
 * by a derived PATH_MISSING at read time.
 */
function buildV12Fixture(): {
  dbPath: string;
  fixture: DatabaseSync;
  alphaDir: string;
  betaDir: string;
} {
  const dir = makeTempDir("ldd-v13-fixture-");
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "v12-final.sqlite");
  const fixture = new DatabaseSync(dbPath);
  openHandles.push(fixture as unknown as { close: () => void });

  const NOW = "2026-09-01T10:00:00.000Z";
  const SCANNED_AT = "2026-09-01T11:00:00.000Z";

  fixture.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  for (const name of V12_MIGRATION_NAMES) {
    if (name === "001_initial") continue;
    fixture.exec(
      fs.readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), "utf8"),
    );
  }
  for (const name of V12_MIGRATION_NAMES) {
    fixture
      .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run(name, NOW);
  }

  const alphaDir = makeTempDir("ldd-v13-alpha-");
  const betaDir = makeTempDir("ldd-v13-beta-");
  cleanupDirs.push(alphaDir, betaDir);

  // Project 1 (alpha): two local bindings (display primary + secondary),
  // health cache both ways, snapshots, commits, activity, app setting.
  fixture
    .prepare(
      `INSERT INTO projects
         (name, project_status, project_type, project_note,
          include_in_portfolio, portfolio_order, created_at, updated_at)
       VALUES ('alpha', 'Active', 'Personal', 'core app', 1, 1, ?, ?)`,
    )
    .run(NOW, NOW);

  fixture
    .prepare(
      `INSERT INTO local_repositories
         (source_id, name, local_path, canonical_path, discovery_type,
          created_at, last_scanned_at, project_id,
          is_primary, last_health_state, last_health_checked_at)
       VALUES (NULL, 'alpha', ?, ?, 'manual', ?, ?, 1, 1, 'OK', ?)`,
    )
    .run(alphaDir, alphaDir.toLowerCase(), NOW, SCANNED_AT, SCANNED_AT);

  fixture
    .prepare(
      `INSERT INTO local_repositories
         (source_id, name, local_path, canonical_path, discovery_type,
          created_at, last_scanned_at, project_id,
          is_primary, last_health_state, last_health_checked_at)
       VALUES (NULL, 'alpha-copy', ?, ?, 'scanned', ?, ?, 1, 0, 'NOT_A_GIT_REPO', ?)`,
    )
    .run(betaDir, betaDir.toLowerCase(), NOW, SCANNED_AT, SCANNED_AT);

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
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('default_scan_depth', '3', ?)`,
    )
    .run(NOW);

  return { dbPath, fixture, alphaDir, betaDir };
}

describe("V1.3 schema compatibility (zero migrations vs accepted V1.2)", () => {
  it("locks the on-disk migration set to the accepted V1.2 chain", () => {
    // Names: exactly 002–009 on disk; runner adds 001_initial for schema.sql.
    expect(expectedOnDiskMigrationNames()).toEqual(
      V12_MIGRATION_NAMES.filter((name) => name !== "001_initial"),
    );
    // Content: identical to the accepted V1.2 tag blobs. Working trees may
    // carry CRLF (core.autocrlf); git stores LF, so normalize before hashing.
    for (const [rel, expectedHash] of Object.entries(V12_SCHEMA_BLOB_HASHES)) {
      const full = path.join(here, rel);
      expect(fs.existsSync(full), `missing schema artifact ${rel}`).toBe(true);
      const normalized = fs.readFileSync(full).toString("utf8").replace(/\r\n/g, "\n");
      const bytes = Buffer.from(normalized, "utf8");
      // Git blob hash = sha1("blob <len>\0" + bytes)
      const hash = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      expect(hash, `schema content drift in ${rel}`).toBe(expectedHash);
    }
    // No extra .sql file may appear under migrations/ (a silent V1.3 migration).
    const extras = expectedOnDiskMigrationNames().filter(
      (name) =>
        !V12_MIGRATION_NAMES.includes(
          name as (typeof V12_MIGRATION_NAMES)[number],
        ),
    );
    expect(extras).toEqual([]);
  });
});

describe("V1.2 → V1.3 database compatibility", () => {
  it("opens a V1.2-final fixture under V1.3 with schema_migrations unchanged and data intact", async () => {
    const { dbPath, fixture, alphaDir } = buildV12Fixture();

    // ---- Pre-open capture -------------------------------------------------
    const beforeMigrations = migrationRows(fixture);
    expect(beforeMigrations.map((row) => row.name)).toEqual([
      ...V12_MIGRATION_NAMES,
    ]);
    expect(beforeMigrations).toHaveLength(9);

    const before = {
      projects: fixture.prepare("SELECT * FROM projects ORDER BY id").all(),
      bindings: fixture
        .prepare("SELECT * FROM local_repositories ORDER BY id")
        .all(),
      snapshots: fixture
        .prepare("SELECT * FROM repository_snapshots ORDER BY id")
        .all(),
      commits: fixture.prepare("SELECT * FROM commits ORDER BY id").all(),
      events: fixture.prepare("SELECT * FROM activity_events ORDER BY id").all(),
      settings: fixture.prepare("SELECT * FROM app_settings ORDER BY key").all(),
    };

    const beforeProjectCount = (
      fixture.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }
    ).n;
    const beforeBindingIds = (
      fixture
        .prepare("SELECT id FROM local_repositories ORDER BY id")
        .all() as Array<{ id: number }>
    ).map((row) => row.id);
    const beforePrimaryFlags = fixture
      .prepare(
        "SELECT id, project_id, is_primary FROM local_repositories ORDER BY id",
      )
      .all() as Array<{ id: number; project_id: number; is_primary: number }>;
    const beforeHealth = fixture
      .prepare(
        `SELECT id, last_health_state, last_health_checked_at
         FROM local_repositories ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      last_health_state: string | null;
      last_health_checked_at: string | null;
    }>;
    const beforeOwnerMetadata = fixture
      .prepare(
        `SELECT id, name, project_status, project_type, project_note,
                include_in_portfolio, portfolio_order
         FROM projects ORDER BY id`,
      )
      .all();
    const beforeEventIds = (
      fixture
        .prepare("SELECT id, fingerprint FROM activity_events ORDER BY id")
        .all() as Array<{ id: number; fingerprint: string }>
    ).map((row) => ({ id: row.id, fingerprint: row.fingerprint }));

    fixture.close();

    // ---- Real V1.3 open path ---------------------------------------------
    process.env.DASHBOARD_DB_PATH = dbPath;
    closeDb();
    const db = openDatabase(dbPath) as DatabaseSync;
    openHandles.push(db as unknown as { close: () => void });

    // 1. open succeeds (we are here) and health is clean.
    assertDatabaseHealth(db);

    // 2–3. schema_migrations is EXACTLY unchanged; no new migration row.
    const afterMigrations = migrationRows(db);
    expect(afterMigrations).toEqual(beforeMigrations);
    expect(afterMigrations.map((row) => row.name)).toEqual([
      ...V12_MIGRATION_NAMES,
    ]);
    expect(afterMigrations).toHaveLength(9);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM schema_migrations WHERE name LIKE '010%' OR name LIKE '011%'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);

    // 4. Representative Project data remains.
    expect(db.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(
      before.projects,
    );
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }
      ).n,
    ).toBe(beforeProjectCount);

    // 5. Local binding identity remains.
    expect(db.prepare("SELECT * FROM local_repositories ORDER BY id").all()).toEqual(
      before.bindings,
    );
    expect(
      (
        db
          .prepare("SELECT id FROM local_repositories ORDER BY id")
          .all() as Array<{ id: number }>
      ).map((row) => row.id),
    ).toEqual(beforeBindingIds);

    // 6. Display-primary state remains.
    expect(
      db
        .prepare(
          "SELECT id, project_id, is_primary FROM local_repositories ORDER BY id",
        )
        .all(),
    ).toEqual(beforePrimaryFlags);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM local_repositories WHERE project_id = 1 AND is_primary = 1",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);

    // 7. Health cache remains.
    expect(
      db
        .prepare(
          `SELECT id, last_health_state, last_health_checked_at
           FROM local_repositories ORDER BY id`,
        )
        .all(),
    ).toEqual(beforeHealth);

    // 8. Owner metadata remains (project_status/type/note/portfolio).
    expect(
      db
        .prepare(
          `SELECT id, name, project_status, project_type, project_note,
                  include_in_portfolio, portfolio_order
           FROM projects ORDER BY id`,
        )
        .all(),
    ).toEqual(beforeOwnerMetadata);

    // 9. Activity/history remains (ids + fingerprints).
    expect(
      (
        db
          .prepare("SELECT id, fingerprint FROM activity_events ORDER BY id")
          .all() as Array<{ id: number; fingerprint: string }>
      ).map((row) => ({ id: row.id, fingerprint: row.fingerprint })),
    ).toEqual(beforeEventIds);
    expect(db.prepare("SELECT * FROM activity_events ORDER BY id").all()).toEqual(
      before.events,
    );

    // Extra domain rows captured wholesale.
    expect(db.prepare("SELECT * FROM repository_snapshots ORDER BY id").all()).toEqual(
      before.snapshots,
    );
    expect(db.prepare("SELECT * FROM commits ORDER BY id").all()).toEqual(
      before.commits,
    );
    expect(db.prepare("SELECT * FROM app_settings ORDER BY key").all()).toEqual(
      before.settings,
    );

    // Binding paths still resolve to the fixture dirs.
    const binding1 = db
      .prepare("SELECT local_path FROM local_repositories WHERE id = 1")
      .get() as { local_path: string };
    expect(binding1.local_path).toBe(alphaDir);

    // 10–11. FK and integrity clean after open.
    assertDatabaseHealth(db);

    // Idempotent second open: still no migration growth, data still intact.
    closeDb();
    const reopened = openDatabase(dbPath) as DatabaseSync;
    openHandles.push(reopened as unknown as { close: () => void });
    expect(migrationRows(reopened)).toEqual(beforeMigrations);
    expect(reopened.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(
      before.projects,
    );
    assertDatabaseHealth(reopened);
  });
});

describe("V1.3 fresh-database release QA", () => {
  it("initializes a pristine database through the real open path", () => {
    const { dbPath, db } = trackDb("ldd-v13-fresh-", "fresh.sqlite");

    expect(fs.existsSync(dbPath)).toBe(true);

    // Complete current migration set applied exactly once.
    expect(migrationNames(db)).toEqual([...V12_MIGRATION_NAMES]);
    const dupes = db
      .prepare(
        "SELECT name FROM schema_migrations GROUP BY name HAVING COUNT(*) > 1",
      )
      .all();
    expect(dupes).toEqual([]);

    // Core expected schema exists.
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const table of [
      "schema_migrations",
      "projects",
      "local_repositories",
      "github_repositories",
      "github_commits",
      "repository_snapshots",
      "commits",
      "activity_events",
      "app_settings",
      "project_sources",
      "git_remotes",
    ]) {
      expect(tables, `missing table ${table}`).toContain(table);
    }

    // V1.2 local-binding shape present on a fresh DB (008/009 applied).
    const columns = (
      db.prepare("PRAGMA table_info(local_repositories)").all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns).toContain("project_id");
    expect(columns).toContain("is_primary");
    expect(columns).toContain("last_health_state");
    expect(columns).toContain("last_health_checked_at");

    assertDatabaseHealth(db);

    // Reopen is idempotent: same chain, still healthy.
    closeDb();
    const reopened = openDatabase(dbPath) as DatabaseSync;
    openHandles.push(reopened as unknown as { close: () => void });
    expect(migrationNames(reopened)).toEqual([...V12_MIGRATION_NAMES]);
    assertDatabaseHealth(reopened);
  });
});
