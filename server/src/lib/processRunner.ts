import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function runExecFile(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeout?: number;
    windowsHide?: boolean;
  } = {},
): Promise<ProcessResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      timeout: options.timeout ?? 20_000,
      windowsHide: options.windowsHide ?? true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      message?: string;
    };
    if (e.code === "ENOENT") {
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "ENOENT",
        code: 127,
      };
    }
    const code = typeof e.code === "number" ? e.code : 1;
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      code,
    };
  }
}
