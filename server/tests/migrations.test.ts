import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/db/client.js";
import { makeTempDir } from "./helpers.js";

const cleanup: string[] = [];

function dbPathFor(dir: string): string {
  return path.join(dir, "test.sqlite");
}

beforeEach(() => {
  const dir = makeTempDir("ldd-mig-");
  cleanup.push(dir);
  process.env.DASHBOARD_DB_PATH = dbPathFor(dir);
  closeDb();
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a database shaped like the Grok checkpoint era: 001 applied, no 002 columns. */
function createLegacyDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE project_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      canonical_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
      scan_depth INTEGER NOT NULL DEFAULT 3,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_scanned_at TEXT
    );
    CREATE TABLE local_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NULL REFERENCES project_sources(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      canonical_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
      discovery_type TEXT NOT NULL CHECK (discovery_type IN ('scanned', 'manual')),
      created_at TEXT NOT NULL,
      last_scanned_at TEXT
    );
    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_repository_id INTEGER NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'scan',
      fingerprint TEXT NOT NULL UNIQUE,
      metadata_json TEXT
    );
    INSERT INTO local_repositories (source_id, name, local_path, canonical_path, discovery_type, created_at)
    VALUES (NULL, 'legacy-repo', 'C:\\repos\\legacy-repo', 'c:\\repos\\legacy-repo', 'scanned', '2026-01-01T00:00:00.000Z');
    INSERT INTO activity_events (local_repository_id, event_type, summary, occurred_at, source, fingerprint)
    VALUES (1, 'commit', 'legacy subject', '2026-01-02T03:04:05.000Z', 'scan', '1:commit:abc123');
  `);
  db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
    "001_initial",
    "2026-01-01T00:00:00.000Z",
  );
  db.close();
}

const EXPECTED_MIGRATIONS = ["001_initial", "002_project_metadata", "003_app_settings"];

describe("Ordered migrations", () => {
  it("applies 001 through 003 in order on a fresh database", () => {
    const db = getDb();
    const rows = db
      .prepare("SELECT name FROM schema_migrations ORDER BY id ASC")
      .all() as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(EXPECTED_MIGRATIONS);

    const columns = (
      db.prepare("PRAGMA table_info(local_repositories)").all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    for (const expected of [
      "project_status",
      "project_type",
      "project_note",
      "include_in_portfolio",
      "portfolio_order",
    ]) {
      expect(columns).toContain(expected);
    }

    const settingsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'")
      .get() as { name: string } | undefined;
    expect(settingsTable?.name).toBe("app_settings");
  });

  it("is a no-op when reopened", () => {
    getDb();
    closeDb();
    const db = getDb();
    const rows = db
      .prepare("SELECT name FROM schema_migrations ORDER BY id ASC")
      .all() as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(EXPECTED_MIGRATIONS);
  });

  it("migrates a legacy database and renames commit events to commit_observed", () => {
    const legacyPath = dbPathFor(makeTempDir("ldd-mig-legacy-"));
    cleanup.push(path.dirname(legacyPath));
    process.env.DASHBOARD_DB_PATH = legacyPath;
    closeDb();

    createLegacyDatabase(legacyPath);

    const db = getDb();
    const rows = db
      .prepare("SELECT name FROM schema_migrations ORDER BY id ASC")
      .all() as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(EXPECTED_MIGRATIONS);

    const events = db
      .prepare("SELECT event_type FROM activity_events WHERE fingerprint = '1:commit:abc123'")
      .all() as { event_type: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("commit_observed");

    const repoColumns = (
      db.prepare("PRAGMA table_info(local_repositories)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(repoColumns).toContain("project_status");

    // Pre-existing rows keep their identity through the migration.
    const repos = db.prepare("SELECT name FROM local_repositories").all() as {
      name: string;
    }[];
    expect(repos).toEqual([{ name: "legacy-repo" }]);
  });
});
