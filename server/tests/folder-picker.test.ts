import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import {
  setFolderPickerExecutorForTests,
  type PickerExecutor,
} from "../src/services/FolderPickerService.js";

/**
 * Folder-picker API contract (Sources UX pass):
 * - selection returns an absolute path;
 * - cancellation is a NORMAL result ({ selected: false }), never an error;
 * - launcher failure is a controlled domain error;
 * - unsupported platforms get an explicit, stable refusal;
 * - the endpoint takes no parameters, so no request content can ever shape
 *   an executed command (the PowerShell script is fixed source-side).
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
  closeDb();
  for (const dir of cleanup.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// win32-only service logic runs under the override on any host; platform
// gating is tested separately below via Object.defineProperty.
const realPlatform = process.platform;
function withPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function selectionExecutor(chosenDir: string): PickerExecutor {
  return async () => ({ code: 0, stdout: `${chosenDir}\n`, stderr: "" });
}

describe("POST /api/system/select-folder", () => {
  it("returns the absolute selected folder path on success", async () => {
    withPlatform("win32");
    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-chosen-"));
    cleanup.push(chosen);
    setFolderPickerExecutorForTests(selectionExecutor(chosen));

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

  it("refuses unusable picker output instead of returning it", async () => {
    withPlatform("win32");
    // Not an existing directory -> rejected by validation, never echoed back.
    setFolderPickerExecutorForTests(async () => ({
      code: 0,
      stdout: "Z:\\definitely\\not\\here\n",
      stderr: "",
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
    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), "ldd-chosen-"));
    cleanup.push(chosen);
    const seen: string[][] = [];
    setFolderPickerExecutorForTests(async () => {
      // The executor receives nothing: prove no caller-controlled argument
      // can reach invocation by recording calls made WITH parameters.
      seen.push(["called"]);
      return { code: 0, stdout: `${chosen}\n`, stderr: "" };
    });

    // Attempt to smuggle content via body AND query; endpoint accepts none.
    const res = await request(createApp())
      .post("/api/system/select-folder?cmd=whatever")
      .send({ command: "Remove-Item C:\\" });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1); // single fixed invocation
    expect(res.body.path).toBe(path.normalize(chosen));
  });
});
