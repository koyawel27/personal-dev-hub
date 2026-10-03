/**
 * Browser-side restart recovery polling.
 * Requires an observed DOWN transition before treating health as recovered.
 */

export type RestartRecoveryResult =
  | "recovered"
  | "never-went-down"
  | "stayed-down";

export type HealthProbe = () => Promise<boolean>;

async function defaultProbe(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

export async function waitForRestartRecovery(options?: {
  timeoutMs?: number;
  initialDelayMs?: number;
  intervalMs?: number;
  probe?: HealthProbe;
}): Promise<RestartRecoveryResult> {
  const timeoutMs = options?.timeoutMs ?? 40000;
  const initialDelayMs = options?.initialDelayMs ?? 800;
  const intervalMs = options?.intervalMs ?? 700;
  const probe = options?.probe ?? defaultProbe;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(initialDelayMs);

  const deadline = Date.now() + timeoutMs;
  let sawDown = false;

  while (Date.now() < deadline) {
    const healthy = await probe();
    if (!healthy) {
      sawDown = true;
    } else if (sawDown) {
      return "recovered";
    }
    await sleep(intervalMs);
  }

  return sawDown ? "stayed-down" : "never-went-down";
}
