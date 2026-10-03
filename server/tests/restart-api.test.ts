import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestRestart = vi.fn(() =>
  Promise.resolve({ ok: true as const, restarting: true as const }),
);

vi.mock("../src/services/RestartService.js", () => ({
  restartCoordinator: {
    requestRestart: () => requestRestart(),
    isRestartInProgress: () => false,
  },
  isRestartInProgress: () => false,
  resetRestartGuardForTests: () => {},
  createRestartCoordinator: () => ({
    requestRestart: () => requestRestart(),
    isRestartInProgress: () => false,
  }),
}));

import { createApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { useTempDb } from "./helpers.js";

const cleanup: string[] = [];

beforeEach(() => {
  const dbPath = useTempDb();
  cleanup.push(path.dirname(dbPath));
  getDb();
  requestRestart.mockClear();
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

describe("POST /api/system/restart", () => {
  it("accepts POST and returns cooperative restart payload", async () => {
    const app = createApp();
    const res = await request(app).post("/api/system/restart");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, restarting: true });
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it("rejects non-POST methods", async () => {
    const app = createApp();
    const res = await request(app).get("/api/system/restart");
    expect(res.status).toBe(404);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("does not use request body for commands or paths", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/system/restart")
      .send({ command: "evil", path: "C:\\evil" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, restarting: true });
    // Coordinator is invoked with no arguments in app.ts.
    expect(requestRestart).toHaveBeenCalledWith();
  });
});
