import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHandoffSpawnArgs,
  createRestartCoordinator,
  handoffSpawnOptions,
  isRestartInProgress,
  isSafeAttemptId,
  newAttemptId,
  parseReadyRecord,
  readyFilePathForAttempt,
  resetRestartGuardForTests,
} from "../src/services/RestartService.js";
import { PROJECT_ROOT } from "../src/config.js";
import {
  registerGracefulShutdown,
  requestGracefulShutdown,
  resetShutdownForTests,
} from "../src/services/RuntimeShutdown.js";
import { waitForRestartRecovery } from "../../client/src/lib/restartPolling.js";

describe("RestartService AttemptId-only handoff", () => {
  beforeEach(() => {
    resetRestartGuardForTests();
    resetShutdownForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetRestartGuardForTests();
    resetShutdownForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("F: argv is exactly flags + -File + -AttemptId (no path parameters)", () => {
    // Production spawns the bootstrap script; the bootstrap Start-Processes
    // the real handoff. The argv shape across the Node → PowerShell boundary
    // is identical either way.
    const handoffScript = path.resolve(
      PROJECT_ROOT,
      "scripts/windows/Start-RestartHandoff.ps1",
    );
    const attemptId = "attemptabc123";
    const args = buildHandoffSpawnArgs({ handoffScript, attemptId });

    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      handoffScript,
      "-AttemptId",
      attemptId,
    ]);
    expect(args).not.toContain("-RepositoryRoot");
    expect(args).not.toContain("-LauncherScript");
    expect(args).not.toContain("-ReadyFile");
  });

  it("E: AttemptId is safe and ready path is server-derived", () => {
    const id = newAttemptId();
    expect(isSafeAttemptId(id)).toBe(true);
    const ready = readyFilePathForAttempt(id);
    expect(ready).toBe(
      path.join(PROJECT_ROOT, "data", "launcher", `restart-handoff-ready-${id}.json`),
    );
    expect(ready).not.toContain("..");
    expect(isSafeAttemptId("../evil")).toBe(false);
    expect(isSafeAttemptId("a/b")).toBe(false);
    expect(isSafeAttemptId("")).toBe(false);
    expect(() => readyFilePathForAttempt("bad id!")).toThrow();
    expect(() => buildHandoffSpawnArgs({ handoffScript: "x", attemptId: "!" })).toThrow();
  });

  it("B: ready acknowledged → shutdown scheduled", async () => {
    const shutdown = vi.fn();
    registerGracefulShutdown(shutdown);
    const coordinator = createRestartCoordinator({
      spawnHandoff: async () => {},
    });
    await coordinator.requestRestart();
    expect(shutdown).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 250));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("A/C: spawn without ready → no shutdown; timeout releases guard", async () => {
    const shutdown = vi.fn();
    registerGracefulShutdown(shutdown);
    const coordinator = createRestartCoordinator({
      spawnHandoff: async () => {
        throw new Error("Restart handoff did not acknowledge readiness.");
      },
    });
    await expect(coordinator.requestRestart()).rejects.toThrow(/readiness/i);
    expect(shutdown).not.toHaveBeenCalled();
    expect(isRestartInProgress()).toBe(false);
  });

  it("D: spawn error → no shutdown, guard released", async () => {
    const shutdown = vi.fn();
    registerGracefulShutdown(shutdown);
    const coordinator = createRestartCoordinator({
      spawnHandoff: async () => {
        throw new Error("spawn failed");
      },
    });
    await expect(coordinator.requestRestart()).rejects.toThrow(/handoff/i);
    expect(shutdown).not.toHaveBeenCalled();
    expect(isRestartInProgress()).toBe(false);
  });

  it("duplicate request during async spawn is rejected", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const coordinator = createRestartCoordinator({
      spawnHandoff: async () => {
        await gate;
      },
    });
    const first = coordinator.requestRestart();
    await Promise.resolve();
    await expect(coordinator.requestRestart()).rejects.toThrow(
      /already in progress/i,
    );
    release();
    await expect(first).resolves.toEqual({ ok: true, restarting: true });
  });

  it("unsupported platform does not spawn or shut down", async () => {
    const shutdown = vi.fn();
    registerGracefulShutdown(shutdown);
    const spawnHandoff = vi.fn(async () => {});
    const coordinator = createRestartCoordinator({
      spawnHandoff,
      platform: "linux",
    });
    await expect(coordinator.requestRestart()).rejects.toThrow(/Windows/i);
    expect(spawnHandoff).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("parseReadyRecord requires ready===true", () => {
    expect(parseReadyRecord('{"ready":true,"handoffPid":9}')).toEqual({
      ready: true,
      handoffPid: 9,
      timestamp: undefined,
    });
    expect(parseReadyRecord('{"ready":false}')).toBeNull();
    expect(parseReadyRecord("x")).toBeNull();
  });

  it("parseReadyRecord tolerates the PowerShell 5.1 UTF-8 BOM", () => {
    // Set-Content -Encoding UTF8 on Windows PowerShell 5.1 prefixes the
    // file with EF BB BF; the ready handshake must still parse.
    expect(parseReadyRecord("\uFEFF{\"ready\":true}")).toEqual({
      ready: true,
      handoffPid: undefined,
      timestamp: undefined,
    });
  });
});

describe("RuntimeShutdown", () => {
  beforeEach(() => {
    resetShutdownForTests();
  });
  it("invokes registered shutdown once", () => {
    const fn = vi.fn();
    registerGracefulShutdown(fn);
    requestGracefulShutdown();
    requestGracefulShutdown();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("waitForRestartRecovery down→up", () => {
  it("recovers only after observing health down then up", async () => {
    const samples = [true, true, false, false, true, true];
    let i = 0;
    const result = await waitForRestartRecovery({
      timeoutMs: 5000,
      initialDelayMs: 0,
      intervalMs: 1,
      probe: async () => samples[i++] ?? true,
    });
    expect(result).toBe("recovered");
  });
  it("never-went-down if health stays ok:true", async () => {
    const result = await waitForRestartRecovery({
      timeoutMs: 30,
      initialDelayMs: 0,
      intervalMs: 5,
      probe: async () => true,
    });
    expect(result).toBe("never-went-down");
  });
  it("stayed-down if health drops but never returns", async () => {
    const result = await waitForRestartRecovery({
      timeoutMs: 30,
      initialDelayMs: 0,
      intervalMs: 5,
      probe: async () => false,
    });
    expect(result).toBe("stayed-down");
  });
});

describe("ready file IO", () => {
  it("parses a written ready record", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdh-ready-"));
    try {
      const ready = path.join(dir, "r.json");
      fs.writeFileSync(
        ready,
        JSON.stringify({ ready: true, handoffPid: 1, timestamp: "t" }),
      );
      expect(parseReadyRecord(fs.readFileSync(ready, "utf8"))?.ready).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Windows spawn boundary", () => {
  // Regression guard for the M2 in-app restart bug: spawnDefaultHandoff used
  // detached:true, which maps to DETACHED_PROCESS on Windows — powershell.exe
  // exits 0 without executing the -File script, so the ready file never
  // appeared and every in-app restart failed closed. These tests exercise the
  // REAL spawn options against real Windows PowerShell.
  it("handoffSpawnOptions never sets detached and stays hidden", () => {
    const opts = handoffSpawnOptions(null);
    expect(opts.detached).toBeUndefined();
    expect(opts.windowsHide).toBe(true);
  });

  it("bootstrap and handoff scripts exist in this checkout", () => {
    expect(
      fs.existsSync(
        path.resolve(PROJECT_ROOT, "scripts/windows/Start-RestartHandoff.ps1"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.resolve(PROJECT_ROOT, "scripts/windows/Restart-Handoff.ps1"),
      ),
    ).toBe(true);
  });

  describe.skipIf(process.platform !== "win32")(
    "real PowerShell spawn (win32 only)",
    () => {
      it(
        "bootstrap chain runs PowerShell and produces a ready file",
        async () => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdh-spawn-"));
          const readyFile = path.join(dir, "probe-ready.json");
          const errFile = path.join(dir, "bootstrap-stderr.log");

          // Probe child: mimics the handoff's readiness handshake (write a
          // ready JSON, exit). No ports, no launcher, nothing process-tree
          // related — safe to run from tests.
          const probeChild = [
            "param([string]$AttemptId)",
            "if ($AttemptId -notmatch '^[A-Za-z0-9_-]+$') { exit 1 }",
            "$payload = @{",
            "  ready      = $true",
            "  handoffPid = $PID",
            "  timestamp  = (Get-Date).ToUniversalTime().ToString('o')",
            "} | ConvertTo-Json",
            `Set-Content -LiteralPath '${readyFile.replace(/'/g, "''")}' -Value $payload -Encoding UTF8`,
            "exit 0",
            "",
          ].join("\r\n");
          fs.writeFileSync(path.join(dir, "Probe-Child.ps1"), probeChild);

          // Real production bootstrap text, retargeted at the probe child:
          // same param binding, StrictMode, Start-Process indirection.
          const realBootstrap = fs.readFileSync(
            path.resolve(PROJECT_ROOT, "scripts/windows/Start-RestartHandoff.ps1"),
            "utf8",
          );
          fs.writeFileSync(
            path.join(dir, "Start-RestartHandoff.ps1"),
            realBootstrap.replace(/'Restart-Handoff\.ps1'/, "'Probe-Child.ps1'"),
          );

          const powerShell = path.join(
            process.env.WINDIR ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          );
          const errFd = fs.openSync(errFile, "a");
          let exitCode: number | null = null;
          try {
            const child = spawn(
              powerShell,
              buildHandoffSpawnArgs({
                handoffScript: path.join(dir, "Start-RestartHandoff.ps1"),
                attemptId: "testbtstrp1",
              }),
              handoffSpawnOptions(errFd),
            );
            child.once("exit", (code) => {
              exitCode = code;
            });

            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
              if (fs.existsSync(readyFile)) break;
              await new Promise((r) => setTimeout(r, 100));
            }
            const readyRecord = fs.existsSync(readyFile)
              ? parseReadyRecord(fs.readFileSync(readyFile, "utf8"))
              : null;
            const stderrOut = fs.readFileSync(errFile, "utf8").trim();
            expect(
              `ready=${readyRecord !== null} exit=${exitCode} stderr=${stderrOut}`,
            ).toBe(`ready=true exit=0 stderr=`);
            expect(readyRecord?.ready).toBe(true);
          } finally {
            fs.closeSync(errFd);
            fs.rmSync(dir, { recursive: true, force: true });
          }
        },
        20000,
      );
    },
  );
});
