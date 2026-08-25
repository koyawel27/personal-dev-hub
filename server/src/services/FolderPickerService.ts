import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AppError, ErrorCodes } from "../lib/errors.js";

/**
 * Native folder picker (local-first UX pass; reliability revision).
 *
 * Opens the OS folder-selection dialog through a FIXED PowerShell script —
 * no request input is ever interpolated into a command line. The endpoint
 * accepts no parameters at all: it cannot execute arbitrary content, and
 * it mutates nothing (the dialog is a pure selection UI; only the chosen
 * path string comes back).
 *
 * Reliability contract (owner regression 78cb18c -> this fix):
 * - the dialog is OWNED by an explicit (invisible, topmost) owner Form, so
 *   it reliably appears in the FOREGROUND over any browser instead of
 *   opening invisibly behind Edge/Brave from an unowned, hidden process;
 * - the picker child is tracked and killed on timeout AND on client
 *   disconnect (browser refresh must never leave a zombie dialog);
 * - the single-flight guard clears in a finally block under EVERY terminal
 *   outcome — selection, cancel, launch failure, script error, timeout,
 *   disconnect — so the next Browse always works without a server restart;
 * - only THIS picker's child is ever terminated.
 *
 * Windows-only by design: this app's native seams (explorer.exe, wt.exe,
 * code.cmd) are already Windows-only, and PowerShell is an accepted
 * runtime dependency there.
 */

export type FolderSelectionOutcome = {
  selected: boolean;
  path: string | null;
};

/**
 * Interactive-dialog budget: long enough to browse deep trees comfortably,
 * short enough that a hung/invisible dialog can never lock Browse for long.
 * (Launcher tooling elsewhere bounds non-interactive tools at seconds; a
 * human-driven modal legitimately needs minutes.)
 */
let pickerTimeoutMs = 3 * 60_000;

/** Test seam: shrink/grow the dialog budget without touching production code paths. */
export function setPickerTimeoutForTests(ms: number): void {
  pickerTimeoutMs = ms;
}

/**
 * Raw process outcome. Both the real spawn path and the test seam produce
 * this shape so parsing/lifecycle rules stay shared and testable.
 */
type PickerResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Test seam: replaces the PowerShell invocation entirely. The executor
 * receives a registerKill() callback — registering a function makes the
 * core treat it exactly like the real child (timeout and disconnect call
 * it, and the core decides the resulting outcome).
 */
export type PickerExecutor = (ctx: {
  registerKill: (kill: () => void) => void;
}) => Promise<PickerResult>;

let pickerExecutorOverride: PickerExecutor | null = null;

export function setFolderPickerExecutorForTests(executor: PickerExecutor | null): void {
  pickerExecutorOverride = executor;
}

/** Per-request mutable state shared between the core and the real spawn. */
type PickerRunState = {
  /** Terminates ONLY this picker's child (real spawn) or the seam's stand-in. */
  kill: (() => void) | null;
  /** Set when the dialog budget elapsed and the child was killed. */
  timedOut: boolean;
  /** Set when the HTTP client went away (refresh/navigation) mid-pick. */
  clientGone: boolean;
};

/** One dialog at a time across the whole app (rapid clicks must not stack). */
let pendingDialog: Promise<FolderSelectionOutcome> | null = null;

/**
 * The dialog script. Reads nothing from stdin/argv, writes exactly one
 * line to stdout: "C:\chosen\path" or the empty string on cancel/dismiss.
 *
 * The dialog is shown WITH an explicit owner Form (invisible, topmost,
 * no taskbar) so the modal reliably takes the foreground over whichever
 * browser is in front. Owner and dialog are disposed in finally — no
 * leftover forms or processes.
 */
const POWERSHELL_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$dialog = $null
$owner = $null
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $owner = New-Object System.Windows.Forms.Form
  $owner.StartPosition = 'CenterScreen'
  $owner.Size = New-Object System.Drawing.Size(10, 10)
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Choose a folder for Personal Dev Hub'
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
  } else {
    Write-Output ''
  }
} finally {
  if ($dialog) { $dialog.Dispose() }
  if ($owner) { $owner.Dispose() }
}
`.trim();

function pickerArguments(): string[] {
  // The console HOST stays hidden (-WindowStyle Hidden + windowsHide); the
  // DIALOG itself is explicitly owned/topmost, which is what makes it
  // visible and focusable. Hiding the console is NOT hiding the dialog.
  return [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-WindowStyle", "Hidden",
    "-Command",
    POWERSHELL_PICKER_SCRIPT,
  ];
}

export async function selectFolder(signal?: AbortSignal): Promise<FolderSelectionOutcome> {
  if (process.platform !== "win32") {
    throw new AppError(
      ErrorCodes.FOLDER_PICKER_UNSUPPORTED,
      "The native folder picker is currently supported on Windows. Type or paste a path instead.",
      501,
    );
  }
  if (pendingDialog) {
    throw new AppError(
      ErrorCodes.FOLDER_PICKER_BUSY,
      "A folder selection dialog is already open.",
      409,
    );
  }

  const state: PickerRunState = { kill: null, timedOut: false, clientGone: false };
  const onAbort = (): void => {
    state.clientGone = true;
    state.kill?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const run =
    pickerExecutorOverride != null
      ? pickerExecutorOverride({
          registerKill: (kill) => {
            state.kill = kill;
          },
        })
      : spawnPickerProcess(state);

  // Single-flight bookkeeping lives OUTSIDE the work promise so the guard
  // tracks exactly the real dialog lifetime and can never go stale: every
  // terminal outcome lands here.
  pendingDialog = (async (): Promise<FolderSelectionOutcome> => {
    const timer = setTimeout(() => {
      state.timedOut = true;
      state.kill?.(); // terminate ONLY this picker's child
    }, pickerTimeoutMs);
    try {
      const result = await run;
      if (state.clientGone) {
        // Browser refreshed/navigated away: the response has nowhere to go.
        // Treat as a quiet cancellation; the child was already terminated.
        return { selected: false, path: null };
      }
      if (state.timedOut) {
        throw new AppError(
          ErrorCodes.FOLDER_PICKER_FAILED,
          "The folder picker closed automatically after inactivity. Try again.",
          500,
        );
      }
      return parsePickerResult(result);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        ErrorCodes.FOLDER_PICKER_FAILED,
        "The folder picker could not be opened.",
        500,
      );
    } finally {
      clearTimeout(timer);
    }
  })();

  try {
    return await pendingDialog;
  } finally {
    pendingDialog = null;
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Controlled child-process execution for the real picker. We deliberately
 * do NOT use the generic runExecFile helper here: the picker needs a held
 * ChildProcess reference so timeout/client-disconnect can terminate THIS
 * child specifically, and so the process can never outlive its request.
 */
function spawnPickerProcess(state: PickerRunState): Promise<PickerResult> {
  return new Promise<PickerResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn("powershell.exe", pickerArguments(), {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }
    state.kill = () => {
      try {
        child.kill();
      } catch {
        // already exited — nothing to terminate
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      resolve({
        code: err.code === "ENOENT" ? 127 : 1,
        stdout,
        stderr: err.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parsePickerResult(result: PickerResult): FolderSelectionOutcome {
  if (result.code === 127 || /is not recognized/i.test(result.stderr)) {
    throw new AppError(
      ErrorCodes.FOLDER_PICKER_FAILED,
      "Could not open the folder picker (PowerShell unavailable).",
      500,
    );
  }
  if (result.code !== 0) {
    throw new AppError(
      ErrorCodes.FOLDER_PICKER_FAILED,
      "The folder picker could not be opened.",
      500,
    );
  }

  const raw = result.stdout.trim();
  if (raw === "") {
    return { selected: false, path: null }; // cancel is NOT an error
  }
  const resolved = pathResolve(raw);
  if (!resolved) {
    throw new AppError(
      ErrorCodes.FOLDER_PICKER_FAILED,
      "The folder picker returned an unusable path.",
      500,
    );
  }
  return { selected: true, path: resolved };
}

function pathResolve(raw: string): string | null {
  const candidate = raw.trim().replace(/^"|"$/g, "");
  if (candidate.length === 0 || candidate.length > 260) return null;
  if (!/^[A-Za-z]:[\\/]/.test(candidate)) return null;
  if (!fs.existsSync(candidate)) return null;
  if (!fs.statSync(candidate).isDirectory()) return null;
  return path.normalize(candidate);
}
