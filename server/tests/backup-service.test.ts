import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createManualBackup,
  deleteManualBackup,
  listBackups,
} from "../src/services/BackupService.js";
import { closeDb, getDb } from "../src/db/client.js";
import { resolveMainDatabaseFile } from "../src/db/backup.js";
import { useTempDb } from "./helpers.js";

/**
 * V1.3 M2 BackupService contract:
 * verified manual snapshot, live-DB placement, classification, inventory,
 * corrupt isolation, and MANUAL-only delete safety.
 */

const cleanup: string[] = [];

function liveDbDir(): string {
  return path.dirname(resolveMainDatabaseFile(getDb()));
}

function backupsDir(): string {
  return path.join(liveDbDir(), "backups");
}

beforeEach(() => {
  const dbPath = useTempDb();
  cleanup.push(path.dirname(dbPath));
  getDb();
  // Opening a fresh DB runs declared-rebuild migrations, which create a
  // migration backup. Clear that side effect so inventory assertions start
  // from a known-empty app-managed backup directory.
  const dir = backupsDir();
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("BackupService (V1.3 M2)", () => {
  it("creates a verified MANUAL snapshot with committed data next to the live DB", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
    ).run("manual-backup-marker", new Date().toISOString());

    const created = createManualBackup();

    expect(created.type).toBe("MANUAL");
    expect(created.filename.startsWith("manual-")).toBe(true);
    expect(created.filename.endsWith(".sqlite")).toBe(true);
    expect(created.verification).toBe("VALID");
    expect(created.sizeBytes).toBeGreaterThan(0);
    expect(created.id).toBe(created.filename);

    // Placement: next to the actual live DB connection, not an arbitrary path.
    const target = path.join(backupsDir(), created.filename);
    expect(fs.existsSync(target)).toBe(true);
    expect(path.dirname(target)).toBe(backupsDir());
    expect(backupsDir().startsWith(liveDbDir())).toBe(true);

    // Snapshot is a real SQLite database containing the committed marker.
    const snap = new DatabaseSync(target, { readOnly: true });
    try {
      const row = snap
        .prepare("SELECT name FROM schema_migrations WHERE name = 'manual-backup-marker'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("manual-backup-marker");
    } finally {
      snap.close();
    }
  });

  it("includes committed-but-uncheckpointed WAL state", () => {
    const db = getDb();
    // Force WAL and keep committed pages out of the main file.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA wal_autocheckpoint = 0;");
    db.exec(
      "CREATE TABLE marker_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL);",
    );
    db.prepare("INSERT INTO marker_notes (note) VALUES (?)").run(
      "wal-only-marker-row",
    );

    const created = createManualBackup();
    expect(created.verification).toBe("VALID");

    const snap = new DatabaseSync(path.join(backupsDir(), created.filename), {
      readOnly: true,
    });
    try {
      const row = snap
        .prepare("SELECT note FROM marker_notes")
        .get() as { note: string };
      expect(row.note).toBe("wal-only-marker-row");
    } finally {
      snap.close();
    }
  });

  it("classifies migration and restore-safety filenames and ignores unrelated files", () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });

    const migration = "pre-006_project_activity-2026-03-04T05-06-07-890Z.sqlite";
    const restoreSafety = "pre-restore-2026-03-04T06-07-08-900Z.sqlite";
    const manual = "manual-2026-03-04T07-08-09-012Z.sqlite";
    fs.writeFileSync(path.join(dir, migration), "x");
    fs.writeFileSync(path.join(dir, restoreSafety), "y");
    fs.writeFileSync(path.join(dir, manual), "z");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
    fs.writeFileSync(path.join(dir, "random.sqlite.bak"), "ignore me too");

    const backups = listBackups();
    const byName = new Map(backups.map((b) => [b.filename, b]));

    expect(backups).toHaveLength(3);
    expect(byName.get(migration)?.type).toBe("MIGRATION");
    expect(byName.get(restoreSafety)?.type).toBe("RESTORE_SAFETY");
    expect(byName.get(manual)?.type).toBe("MANUAL");
    expect(byName.has("notes.txt")).toBe(false);
    expect(byName.has("random.sqlite.bak")).toBe(false);

    // createdAt parsed from the app-managed filename stamp.
    expect(byName.get(manual)?.createdAt).toBe("2026-03-04T07:08:09.012Z");
  });

  it("lists recognized backups newest first", () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const older = "manual-2026-01-01T00-00-00-000Z.sqlite";
    const newer = "manual-2026-06-01T12-00-00-000Z.sqlite";
    const middle = "pre-009_local_binding_health-2026-03-15T08-00-00-000Z.sqlite";
    fs.writeFileSync(path.join(dir, older), "a");
    fs.writeFileSync(path.join(dir, newer), "b");
    fs.writeFileSync(path.join(dir, middle), "c");

    const backups = listBackups();
    expect(backups.map((b) => b.filename)).toEqual([newer, middle, older]);
  });

  it("returns corrupt recognized backups as INVALID without failing the list", () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const good = createManualBackup();
    const badName = "manual-2025-12-31T23-59-59-999Z.sqlite";
    fs.writeFileSync(path.join(dir, badName), "not-a-sqlite-database");

    const backups = listBackups();
    expect(backups).toHaveLength(2);
    const bad = backups.find((b) => b.filename === badName);
    const ok = backups.find((b) => b.filename === good.filename);
    expect(bad?.verification).toBe("INVALID");
    expect(ok?.verification).toBe("VALID");
  });

  it("deletes MANUAL backups and reports missing ones cleanly", () => {
    const created = createManualBackup();
    expect(fs.existsSync(path.join(backupsDir(), created.filename))).toBe(true);

    deleteManualBackup(created.filename);
    expect(fs.existsSync(path.join(backupsDir(), created.filename))).toBe(false);

    expect(() => deleteManualBackup(created.filename)).toThrow(/not found/i);
  });

  it("rejects deletion of MIGRATION and RESTORE_SAFETY backups", () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const migration = "pre-006_project_activity-2026-03-04T05-06-07-890Z.sqlite";
    const restoreSafety = "pre-restore-2026-03-04T06-07-08-900Z.sqlite";
    fs.writeFileSync(path.join(dir, migration), "keep");
    fs.writeFileSync(path.join(dir, restoreSafety), "keep");

    expect(() => deleteManualBackup(migration)).toThrow(
      /Only manual application backups can be deleted/i,
    );
    expect(() => deleteManualBackup(restoreSafety)).toThrow(
      /Only manual application backups can be deleted/i,
    );
    expect(fs.existsSync(path.join(dir, migration))).toBe(true);
    expect(fs.existsSync(path.join(dir, restoreSafety))).toBe(true);
  });

  it("rejects traversal and arbitrary path delete ids", () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(liveDbDir(), "outside.sqlite");
    fs.writeFileSync(outside, "untouched");

    for (const id of [
      "../outside.sqlite",
      "..\\outside.sqlite",
      "subdir/manual-2026-03-04T05-06-07-890Z.sqlite",
      "/etc/passwd",
      "C:\\Windows\\system32\\config\\SAM",
      "manual-2026-03-04T05-06-07-890Z.sqlite/../outside.sqlite",
    ]) {
      expect(() => deleteManualBackup(id)).toThrow();
    }
    expect(fs.existsSync(outside)).toBe(true);

    // Unrecognized non-app-managed names are not deletable either.
    expect(() => deleteManualBackup("notes.txt")).toThrow();
    expect(() => deleteManualBackup("")).toThrow();
    expect(() => deleteManualBackup(null)).toThrow();
  });
});
