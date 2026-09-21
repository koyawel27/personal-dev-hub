import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { useTempDb } from "./helpers.js";

const cleanup: string[] = [];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  cleanup.push(path.dirname(useTempDb()));
  getDb();
  app = createApp();
});

afterEach(() => {
  closeDb();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Settings API", () => {
  it("returns defaults and the resolved git executable", async () => {
    const res = await request(app).get("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body.settings.defaultScanDepth).toBe(3);
    expect(res.body.settings.gitExecutable).toBeTruthy();
    // Release QA defect fix: the reported App data path is the ACTUAL
    // resolved database file (DASHBOARD_DB_PATH override), not a hardcoded
    // default. useTempDb() set it in beforeEach.
    expect(res.body.settings.dataPath).toBe(process.env.DASHBOARD_DB_PATH);
  });

  it("persists a new default scan depth across a database reopen", async () => {
    const patched = await request(app)
      .patch("/api/settings")
      .send({ defaultScanDepth: 5 });
    expect(patched.status).toBe(200);
    expect(patched.body.settings.defaultScanDepth).toBe(5);
    // PATCH returns the same complete shape, including the resolved dataPath.
    expect(patched.body.settings.dataPath).toBe(process.env.DASHBOARD_DB_PATH);

    // Simulate restart.
    closeDb();
    getDb();
    const freshApp = createApp();
    const reopened = await request(freshApp).get("/api/settings");
    expect(reopened.body.settings.defaultScanDepth).toBe(5);
  });

  it("rejects invalid depths and unknown keys", async () => {
    const tooHigh = await request(app).patch("/api/settings").send({ defaultScanDepth: 9 });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error.code).toBe("INVALID_REQUEST");

    const fractional = await request(app)
      .patch("/api/settings")
      .send({ defaultScanDepth: 1.5 });
    expect(fractional.status).toBe(400);

    const unknownKey = await request(app)
      .patch("/api/settings")
      .send({ theme: "dark" });
    expect(unknownKey.status).toBe(400);

    // dataPath is informational, not mutable through Settings.
    const dataPathAttempt = await request(app)
      .patch("/api/settings")
      .send({ dataPath: "C:\\elsewhere.sqlite" });
    expect(dataPathAttempt.status).toBe(400);
    expect(dataPathAttempt.body.error.code).toBe("INVALID_REQUEST");
  });
});
