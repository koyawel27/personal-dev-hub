import fs from "node:fs";
import path from "node:path";
import { runExecFile } from "../lib/processRunner.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

/**
 * Native folder picker (local-first UX pass).
 *
 * Opens the OS folder-selection dialog through a FIXED PowerShell script —
 * no request input is ever interpolated into a command line. The endpoint
 * accepts no parameters at all: it cannot execute arbitrary content, and
 * it mutates nothing (the dialog is a pure selection UI; only the chosen
 * path string comes back).
 *
 * Windows-only by design: this app's native seams (explorer.exe, wt.exe,
 * code.cmd) are already Windows-only, and PowerShell is an accepted
 * runtime dependency there.
 */

/** One dialog at a time across the whole app (rapid clicks must not stack). */
let pendingDialog: Promise<FolderSelectionOutcome> | null = null;

export type FolderSelectionOutcome = {
  selected: boolean;
  path: string | null;
};

/** Test seam: replaces the PowerShell invocation entirely. */
export type PickerExecutor = () => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

let pickerExecutorOverride: PickerExecutor | null = null;

export function setFolderPickerExecutorForTests(executor: PickerExecutor | null): void {
  pickerExecutorOverride = executor;
}

/**
 * The dialog script. Reads nothing from stdin/argv, writes exactly one
 * line to stdout: "C:\chosen\path" or the empty string on cancel/dismiss.
 */
const POWERSHELL_PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder for Personal Dev Hub'
$dialog.ShowNewButton = $false
$dialog.UseDescriptionForTitle = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
} else {
  Write-Output ''
}
`.trim();

export async function selectFolder(): Promise<FolderSelectionOutcome> {
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

  const run = invokePicker();
  pendingDialog = run;
  try {
    return await run;
  } finally {
    pendingDialog = null;
  }
}

async function invokePicker(): Promise<FolderSelectionOutcome> {
  try {
    const result =
      pickerExecutorOverride != null
        ? await pickerExecutorOverride()
        : await runExecFile(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-STA",
              "-WindowStyle", "Hidden",
              "-Command",
              POWERSHELL_PICKER_SCRIPT,
            ],
            // The dialog stays open until the user decides; give it room
            // while still bounding a hung process.
            { timeout: 10 * 60_000, windowsHide: true },
          );

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
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      ErrorCodes.FOLDER_PICKER_FAILED,
      "The folder picker could not be opened.",
      500,
    );
  }
}

function pathResolve(raw: string): string | null {
  const candidate = raw.trim().replace(/^"|"$/g, "");
  if (candidate.length === 0 || candidate.length > 260) return null;
  if (!/^[A-Za-z]:[\\/]/.test(candidate)) return null;
  if (!fs.existsSync(candidate)) return null;
  if (!fs.statSync(candidate).isDirectory()) return null;
  return path.normalize(candidate);
}
