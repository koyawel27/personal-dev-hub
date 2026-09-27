import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { useTempDb } from "./helpers.js";

/**
 * V1.3 M2 backups REST surface: GET inventory, POST create, DELETE manual-only.
 */

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const dbPath = useTempDb();
  cleanup.push(path.dirname(dbPath));
  getDb();
  // Declared-rebuild migrations leave a migration backup on first open;
  // clear it so API inventory assertions start from a known-empty list.
  const dir = path.join(path.dirname(dbPath), "backups");
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
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

function backupsDir(): string {
  return path.join(path.dirname(process.env.DASHBOARD_DB_PATH ?? ""), "backups");
}

describe("Backups API (V1.3 M2)", () => {
  it("GET /api/backups returns an empty inventory when none exist", async () => {
    const res = await request(app).get("/api/backups");
    expect(res.status).toBe(200);
    expect(res.body.backups).toEqual([]);
  });

  it("POST /api/backups creates a verified MANUAL backup and GET lists it", async () => {
    const created = await request(app).post("/api/backups");
    expect(created.status).toBe(201);
    expect(created.body.backup.type).toBe("MANUAL");
    expect(created.body.backup.verification).toBe("VALID");
    expect(created.body.backup.filename.startsWith("manual-")).toBe(true);
    expect(created.body.backup.sizeBytes).toBeGreaterThan(0);

    const list = await request(app).get("/api/backups");
    expect(list.status).toBe(200);
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.backups[0].id).toBe(created.body.backup.id);
    expect(list.body.backups[0].filename).toBe(created.body.backup.filename);
  });

  it("DELETE /api/backups/:id removes a manual backup", async () => {
    const created = await request(app).post("/api/backups");
    const id = created.body.backup.id as string;

    const deleted = await request(app).delete(`/api/backups/${encodeURIComponent(id)}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const list = await request(app).get("/api/backups");
    expect(list.body.backups).toEqual([]);
  });

  it("DELETE rejects migration backups and traversal ids", async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const migration = "pre-006_project_activity-2026-03-04T05-06-07-890Z.sqlite";
    fs.writeFileSync(path.join(dir, migration), "keep");

    const forbidden = await request(app).delete(
      `/api/backups/${encodeURIComponent(migration)}`,
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("BACKUP_DELETE_FORBIDDEN");
    expect(fs.existsSync(path.join(dir, migration))).toBe(true);

    const traversal = await request(app).delete(
      `/api/backups/${encodeURIComponent("../outside.sqlite")}`,
    );
    expect(traversal.status).toBe(400);
    expect(traversal.body.error.code).toBe("INVALID_REQUEST");
  });

  it("DELETE of a missing manual backup returns 404", async () => {
    const missing = "manual-2020-01-01T00-00-00-000Z.sqlite";
    const res = await request(app).delete(`/api/backups/${encodeURIComponent(missing)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("BACKUP_NOT_FOUND");
  });
});
