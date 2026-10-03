/**
 * Cooperative in-app restart (Windows launcher handoff).
 *
 * Only a restricted AttemptId crosses Node → PowerShell. The handoff script
 * derives all filesystem paths from its own location. Shutdown is scheduled
 * only after the handoff writes the server-derived ready file.
 *
 * Node spawns the tiny Start-RestartHandoff.ps1 bootstrap (non-detached,
 * hidden), which Start-Processes the real Restart-Handoff.ps1 and exits.
 * Both steps are required on Windows: spawned with detached:true,
 * powershell.exe exits 0 without running the script at all, and spawned
 * non-detached it is killed shortly after the server process exits —
 * Start-Process (the same primitive the M1 launcher uses) creates the
 * orphan that survives. The server stays alive until the ready file
 * appears, by which time the handoff is already independent.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { requestGracefulShutdown } from "./RuntimeShutdown.js";

export type RestartRequestResult = {
  ok: true;
  restarting: true;
};

export type HandoffSpawn = () => Promise<void>;

export type RestartCoordinator = {
  requestRestart: () => Promise<RestartRequestResult>;
  isRestartInProgress: () => boolean;
};

export type ReadyRecord = {
  ready: boolean;
  handoffPid?: number;
  timestamp?: string;
};

const ATTEMPT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSafeAttemptId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 6 && id.length <= 64 && ATTEMPT_ID_RE.test(id);
}

/** Server-generated opaque attempt id (never from HTTP). */
export function newAttemptId(): string {
  return `a${Date.now().toString(36)}${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Same ready path the handoff derives from $PSScriptRoot + AttemptId.
 * Not passed to PowerShell.
 */
export function readyFilePathForAttempt(attemptId: string): string {
  if (!isSafeAttemptId(attemptId)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Invalid restart attempt id.");
  }
  return path.join(
    PROJECT_ROOT,
    "data",
    "launcher",
    `restart-handoff-ready-${attemptId}.json`,
  );
}

/**
 * Exact PowerShell argv: AttemptId only. No caller filesystem paths.
 */
export function buildHandoffSpawnArgs(options: {
  handoffScript: string;
  attemptId: string;
}): string[] {
  if (!isSafeAttemptId(options.attemptId)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Invalid restart attempt id.");
  }
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    options.handoffScript,
    "-AttemptId",
    options.attemptId,
  ];
}

/**
 * Production spawn options for the handoff bootstrap.
 *
 * detached is deliberately ABSENT: on Windows it maps to DETACHED_PROCESS
 * (a console-less environment in which powershell.exe 5.1 exits 0 without
 * executing the -File script — established empirically on the target
 * machine). A non-detached hidden child runs PowerShell normally; it does
 * not need to outlive the server because the real handoff is created via
 * Start-Process inside the bootstrap.
 */
export function handoffSpawnOptions(errFd: number | null): SpawnOptions {
  return {
    stdio: ["ignore", "ignore", errFd == null ? "ignore" : errFd],
    windowsHide: true,
    windowsVerbatimArguments: false,
  };
}

export function parseReadyRecord(raw: string): ReadyRecord | null {
  try {
    // Windows PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM
    // (EF BB BF); JSON.parse rejects a BOM-prefixed string, so strip it.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || obj.ready !== true) return null;
    const handoffPid =
      typeof obj.handoffPid === "number" && obj.handoffPid > 0
        ? obj.handoffPid
        : undefined;
    return {
      ready: true,
      handoffPid,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
    };
  } catch {
    return null;
  }
}

function readReadyFile(readyFile: string): ReadyRecord | null {
  try {
    if (!fs.existsSync(readyFile)) return null;
    return parseReadyRecord(fs.readFileSync(readyFile, "utf8"));
  } catch {
    return null;
  }
}

async function waitForReadyFile(
  readyFile: string,
  timeoutMs: number,
): Promise<ReadyRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = readReadyFile(readyFile);
    if (rec) return rec;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readReadyFile(readyFile);
}

function launcherDir(): string {
  return path.join(PROJECT_ROOT, "data", "launcher");
}

function ensureLauncherDir(): void {
  fs.mkdirSync(launcherDir(), { recursive: true });
}

export function handoffErrorLogPath(): string {
  return path.join(launcherDir(), "restart-handoff-error.log");
}

let restartInProgress = false;

function isWindows(): boolean {
  return process.platform === "win32";
}

export async function spawnDefaultHandoff(): Promise<{
  attemptId: string;
  readyFile: string;
  child: ChildProcess;
}> {
  if (!isWindows()) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "In-app restart is only supported on Windows.",
      400,
    );
  }

  const bootstrapScript = path.resolve(
    PROJECT_ROOT,
    "scripts",
    "windows",
    "Start-RestartHandoff.ps1",
  );
  const handoffScript = path.resolve(
    PROJECT_ROOT,
    "scripts",
    "windows",
    "Restart-Handoff.ps1",
  );
  const powerShell = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  if (!fs.existsSync(bootstrapScript)) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      "Restart bootstrap script was not found in this checkout.",
      500,
    );
  }
  if (!fs.existsSync(handoffScript)) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      "Restart handoff script was not found in this checkout.",
      500,
    );
  }
  if (!fs.existsSync(powerShell)) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      "Windows PowerShell was not found for the restart handoff.",
      500,
    );
  }

  ensureLauncherDir();
  const attemptId = newAttemptId();
  const readyFile = readyFilePathForAttempt(attemptId);
  try {
    fs.rmSync(readyFile, { force: true });
    fs.rmSync(`${readyFile}.tmp`, { force: true });
  } catch {
    // best effort
  }

  // The spawned script is the bootstrap; it Start-Processes the real
  // Restart-Handoff.ps1 and exits. Same restricted argv shape as before.
  const spawnArgs = buildHandoffSpawnArgs({ handoffScript: bootstrapScript, attemptId });

  // Durable bootstrap stderr (survives parent exit).
  const errLog = handoffErrorLogPath();
  let errFd: number | null = null;
  try {
    errFd = fs.openSync(errLog, "a");
    fs.writeSync(
      errFd,
      `\n${new Date().toISOString()} handoff spawn attempt=${attemptId}\n`,
    );
  } catch {
    errFd = null;
  }

  let child: ChildProcess;
  try {
    child = spawn(powerShell, spawnArgs, handoffSpawnOptions(errFd));
  } catch (err) {
    if (errFd != null) {
      try {
        fs.closeSync(errFd);
      } catch {
        // best effort
      }
    }
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      `Restart handoff could not be started. (${String(err)})`,
      500,
    );
  }

  if (errFd != null) {
    try {
      fs.closeSync(errFd);
    } catch {
      // best effort
    }
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // best effort
      }
      reject(err);
    };
    child.once("error", (err) =>
      fail(
        new AppError(
          ErrorCodes.INTERNAL_ERROR,
          `Restart handoff process failed to start. (${String(err)})`,
          500,
        ),
      ),
    );
    child.once("spawn", () => {
      if (settled) return;
      if (typeof child.pid !== "number") {
        fail(
          new AppError(
            ErrorCodes.INTERNAL_ERROR,
            "Restart handoff process did not start.",
            500,
          ),
        );
        return;
      }
      settled = true;
      child.unref();
      resolve();
    });
    setTimeout(() => {
      if (!settled) {
        fail(
          new AppError(
            ErrorCodes.INTERNAL_ERROR,
            "Restart handoff spawn did not confirm in time.",
            500,
          ),
        );
      }
    }, 3000);
  });

  const ready = await waitForReadyFile(readyFile, 8000);
  if (!ready) {
    // Fail-closed: kill only the bootstrap child and never shut down. Any
    // handoff already started via Start-Process is not ours to manage; it
    // observes port 8787 still listening and exits without launching.
    try {
      child.kill();
    } catch {
      // best effort
    }
    try {
      fs.rmSync(readyFile, { force: true });
    } catch {
      // best effort
    }
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      "Restart handoff did not acknowledge readiness. Personal Dev Hub was not stopped. " +
        `See ${errLog} and data/launcher/restart-handoff.log.`,
      500,
    );
  }

  return { attemptId, readyFile, child };
}

async function defaultRequestRestart(
  spawnHandoff: HandoffSpawn = async () => {
    await spawnDefaultHandoff();
  },
  platform: string = process.platform,
): Promise<RestartRequestResult> {
  if (restartInProgress) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "A restart is already in progress.",
      409,
    );
  }

  if (platform !== "win32") {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "In-app restart is only supported on Windows.",
      400,
    );
  }

  restartInProgress = true;
  try {
    await spawnHandoff();
  } catch (err) {
    restartInProgress = false;
    if (err instanceof AppError) throw err;
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      `Restart handoff could not be started. (${String(err)})`,
      500,
    );
  }

  setTimeout(() => {
    requestGracefulShutdown();
  }, 200);
  return { ok: true, restarting: true };
}

export function isRestartInProgress(): boolean {
  return restartInProgress;
}

export function resetRestartGuardForTests(): void {
  restartInProgress = false;
}

export function createRestartCoordinator(
  overrides?: {
    requestRestart?: () => Promise<RestartRequestResult>;
    spawnHandoff?: HandoffSpawn;
    platform?: string;
  },
): RestartCoordinator {
  if (overrides?.requestRestart) {
    return {
      requestRestart: overrides.requestRestart,
      isRestartInProgress: () => restartInProgress,
    };
  }
  const spawnHandoff = overrides?.spawnHandoff;
  const platform = overrides?.platform;
  return {
    requestRestart: () => defaultRequestRestart(spawnHandoff, platform),
    isRestartInProgress: () => restartInProgress,
  };
}

export const restartCoordinator: RestartCoordinator = createRestartCoordinator();
