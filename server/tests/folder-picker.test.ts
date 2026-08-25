import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import {
  selectFolder,
  setFolderPickerExecutorForTests,
  setPickerTimeoutForTests,
  type PickerExecutor,
} from "../src/services/FolderPickerService.js";

/**
 * Folder-picker reliability contract (owner regression: invisible/hung
 * dialog left the app permanently BUSY).
 *
 * Pinned here, at the seam (never the real modal UI):
 * - selection/cancel/failure/timeout/disconnect ALL clear the single-flight
 *   guard — the next Browse always works without a server restart;
 * - timeout and client disconnect TERMINATE only this picker's child;
 * - BUSY means a genuinely open picker, never a stale promise;
 * - the endpoint accepts no parameters, so no request content can shape
 *   command execution (the PowerShell script is fixed source-side).
 */

const cleanup: string[] = [];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-picker-"));
  cleanup.push(dir);
  process.env.DASHBOARD_DB_PATH = path.join(dir, "test.sqlite");
  closeDb();
});

afterEach(() => {
  setFolderPickerExecutorForTests(null);
  setPickerTimeoutForTests(3 * 60_000);
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

const realPlatform = process.platform;
function withPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** Executor whose promise resolves only when its registered kill fires. */
function hangingExecutor(): {
  executor: PickerExecutor;
  killed: () => boolean;
  settleWithFailure: () => void;
} {
  let killFn: (() => void) | null = null;
  let wasKilled = false;
  let settle: ((result: { code: number; stdout: string; stderr: string }) => void) | null =
    null;
  const executor: PickerExecutor = ({ registerKill }) =>
    new Promise((resolve) => {
      settle = resolve;
      registerKill(() => {
        wasKilled = true;
        resolve({ code: 1, stdout: "", stderr: "terminated by core" });
      });
      killFn = () => {
        /* captured through registerKill */
      };
      void killFn;
    });
  return {
    executor,
    killed: () => wasKilled,
    settleWithFailure: () =>
      settle?.({ code: 1, stdout: "", stderr: "script exploded" }),
  };
}

describe("POST /api/system/select-folder", () => {
  it("returns the absolute selected folder path on success", async () => {
    withPlatform("win32");
    const chosen = tempDir("ldd-chosen-");
    setFolderPickerExecutorForTests(async () => ({
      code: 0,
      stdout: `${chosen}\n`,
      stderr: "",
    }));

    const res = await request(createApp()).post("/api/system/select-folder");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ selected: true, path: path.normalize(chosen) });
  });

  it("returns a normal non-error result on cancellation", async () => {
    withPlatform("win32");
    setFolderPickerExecutorForTests(async () => ({ code: 0, stdout: "", stderr: "" }));

    const res = await request(createApp()).post("/api/system/select-folder");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ selected: false, path: null });
  });

  it("maps dialog-launcher failure to a controlled domain error", async () => {
    withPlatform("win32");
    setFolderPickerExecutorForTests(async () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
    }));

    const res = await request(createApp()).post("/api/system/select-folder");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("FOLDER_PICKER_FAILED");
  });

  it("is explicit about unsupported platforms", async () => {
    withPlatform("linux");
    try {
      const res = await request(createApp()).post("/api/system/select-folder");
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe("FOLDER_PICKER_UNSUPPORTED");
    } finally {
      withPlatform(realPlatform);
    }
  });

  it("ignores request input entirely (no command shaping surface)", async () => {
    withPlatform("win32");
    const chosen = tempDir("ldd-chosen-");
    const seen: number[] = [];
    setFolderPickerExecutorForTests(async () => {
      seen.push(1);
      return { code: 0, stdout: `${chosen}\n`, stderr: "" };
    });

    // Attempt to smuggle content via body AND query; endpoint accepts none.
    const res = await request(createApp())
      .post("/api/system/select-folder?cmd=whatever")
      .send({ command: "Remove-Item C:\\" });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(res.body.path).toBe(path.normalize(chosen));
  });

  it("reports BUSY while a picker is genuinely open — and recovers after it ends", async () => {
    withPlatform("win32");
    const hang = hangingExecutor();
    setFolderPickerExecutorForTests(hang.executor);

    // Service level (supertest only transmits on await, which would make
    // the probe itself the picker call): hold one picker genuinely open.
    const first = selectFolder();
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(selectFolder()).rejects.toMatchObject({
      code: "FOLDER_PICKER_BUSY",
      status: 409,
    });

    hang.settleWithFailure();
    await expect(first).rejects.toMatchObject({
      code: "FOLDER_PICKER_FAILED",
    });

    // Guard cleared by the failure: the NEXT browse is accepted.
    setFolderPickerExecutorForTests(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    await expect(selectFolder()).resolves.toEqual({
      selected: false,
      path: null,
    });
  });
});

describe("picker process lifecycle (service level)", () => {
  it("timeout kills the child, refuses with a controlled error, and clears the guard", async () => {
    withPlatform("win32");
    setPickerTimeoutForTests(50);
    const hang = hangingExecutor();
    setFolderPickerExecutorForTests(hang.executor);

    await expect(selectFolder()).rejects.toMatchObject({
      code: "FOLDER_PICKER_FAILED",
    });
    expect(hang.killed()).toBe(true);

    // Immediately usable again — no restart, no stale BUSY.
    const chosen = tempDir("ldd-chosen-");
    setFolderPickerExecutorForTests(async () => ({
      code: 0,
      stdout: `${chosen}\n`,
      stderr: "",
    }));
    await expect(selectFolder()).resolves.toEqual({
      selected: true,
      path: path.normalize(chosen),
    });
  });

  it("client disconnect kills the child and clears the guard", async () => {
    withPlatform("win32");
    const hang = hangingExecutor();
    setFolderPickerExecutorForTests(hang.executor);

    const controller = new AbortController();
    const pending = selectFolder(controller.signal);
    controller.abort(); // browser refreshed mid-pick

    await expect(pending).resolves.toEqual({ selected: false, path: null });
    expect(hang.killed()).toBe(true);

    // Next Browse works right away.
    setFolderPickerExecutorForTests(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    await expect(selectFolder()).resolves.toEqual({
      selected: false,
      path: null,
    });
  });

  it("process failure does not poison future requests", async () => {
    withPlatform("win32");
    setFolderPickerExecutorForTests(async () => ({
      code: 127,
      stdout: "",
      stderr: "powershell is not recognized",
    }));
    await expect(selectFolder()).rejects.toMatchObject({
      code: "FOLDER_PICKER_FAILED",
    });

    setFolderPickerExecutorForTests(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    await expect(selectFolder()).resolves.toEqual({
      selected: false,
      path: null,
    });
  });
});
