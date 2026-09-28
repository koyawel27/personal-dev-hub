import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { createVerifiedSqliteSnapshot } from "../src/db/backup.js";
import { useTempDb } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";

/**
 * V1.3 M3 restore API: schedule-only HTTP surface (live DB is never replaced).
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

function backupsDir(): string {
  return path.join(path.dirname(process.env.DASHBOARD_DB_PATH ?? ""), "backups");
}

function statePath(): string {
  return path.join(path.dirname(process.env.DASHBOARD_DB_PATH ?? ""), "restore-state.json");
}

function writeValidManualBackup(): string {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = "manual-2026-03-04T05-06-07-890Z.sqlite";
  const target = path.join(dir, filename);
  const tmp = path.join(dir, "api-fixture.sqlite");
  const db = new DatabaseSync(tmp);
  try {
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY);`);
  } finally {
    db.close();
  }
  const src = new DatabaseSync(tmp);
  try {
    createVerifiedSqliteSnapshot(src, target);
  } finally {
    src.close();
  }
  fs.rmSync(tmp, { force: true });
  return filename;
}

beforeEach(() => {
  const dbPath = useTempDb();
  cleanup.push(path.dirname(dbPath));
  getDb();
  const dir = backupsDir();
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
  if (fs.existsSync(statePath())) fs.rmSync(statePath(), { force: true });
  app = createApp();
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

describe("Restore API (V1.3 M3)", () => {
  it("GET /api/restore returns null when no state exists", async () => {
    const res = await request(app).get("/api/restore");
    expect(res.status).toBe(200);
    expect(res.body.restore).toBeNull();
  });

  it("POST schedule requires confirmation and does not replace the live DB", async () => {
    const id = writeValidManualBackup();
    const live = process.env.DASHBOARD_DB_PATH!;
    const before = fs.readFileSync(live);

    const missingConfirm = await request(app)
      .post(`/api/backups/${encodeURIComponent(id)}/restore`)
      .send({});
    expect(missingConfirm.status).toBe(400);
    expect(missingConfirm.body.error.code).toBe("RESTORE_CONFIRM_REQUIRED");

    const scheduled = await request(app)
      .post(`/api/backups/${encodeURIComponent(id)}/restore`)
      .send({ confirmRestore: true });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.restore.status).toBe("PENDING");
    expect(scheduled.body.restore.backupId).toBe(id);

    // Live database bytes unchanged by scheduling.
    expect(fs.readFileSync(live).equals(before)).toBe(true);

    const state = await request(app).get("/api/restore");
    expect(state.body.restore.status).toBe("PENDING");
  });

  it("rejects a second PENDING schedule and allows cancel", async () => {
    const id = writeValidManualBackup();
    await request(app)
      .post(`/api/backups/${encodeURIComponent(id)}/restore`)
      .send({ confirmRestore: true });

    const dup = await request(app)
      .post(`/api/backups/${encodeURIComponent(id)}/restore`)
      .send({ confirmRestore: true });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("RESTORE_ALREADY_PENDING");

    const cancelled = await request(app).delete("/api/restore");
    expect(cancelled.status).toBe(200);
    const after = await request(app).get("/api/restore");
    expect(after.body.restore).toBeNull();
  });

  it("rejects invalid and missing backups", async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manual-2026-03-04T05-06-07-890Z.sqlite"), "junk");

    const invalid = await request(app)
      .post(`/api/backups/${encodeURIComponent("manual-2026-03-04T05-06-07-890Z.sqlite")}/restore`)
      .send({ confirmRestore: true });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("RESTORE_BACKUP_INVALID");

    const missing = await request(app)
      .post(`/api/backups/${encodeURIComponent("manual-2020-01-01T00-00-00-000Z.sqlite")}/restore`)
      .send({ confirmRestore: true });
    expect(missing.status).toBe(404);

    const traversal = await request(app)
      .post(`/api/backups/${encodeURIComponent("../outside.sqlite")}/restore`)
      .send({ confirmRestore: true });
    expect(traversal.status).toBe(400);
  });

  it("dismisses terminal restore state", async () => {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        status: "SUCCEEDED",
        backupId: "manual-2026-03-04T05-06-07-890Z.sqlite",
        requestedAt: "2026-03-04T05:06:07.890Z",
        completedAt: "2026-03-04T05:06:08.000Z",
        preRestoreBackupId: "pre-restore-2026-03-04T05-06-08-000Z.sqlite",
        message: null,
      }),
    );
    const before = await request(app).get("/api/restore");
    expect(before.body.restore.status).toBe("SUCCEEDED");

    const dismissed = await request(app).delete("/api/restore");
    expect(dismissed.status).toBe(200);
    const after = await request(app).get("/api/restore");
    expect(after.body.restore).toBeNull();
  });
});
