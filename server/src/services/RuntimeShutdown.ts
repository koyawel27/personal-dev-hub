/**
 * Cooperative process shutdown for the local HTTP server.
 * The restart endpoint calls this after the response can flush; SIGINT/SIGTERM
 * use the same path. No process-tree management lives here.
 */
type ShutdownFn = () => void;

let shutdownFn: ShutdownFn | null = null;
let shuttingDown = false;

export function registerGracefulShutdown(fn: ShutdownFn): void {
  shutdownFn = fn;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function requestGracefulShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    shutdownFn?.();
  } catch {
    // Shutdown must not throw into request handlers.
  }
}

/** Test seam. */
export function resetShutdownForTests(): void {
  shutdownFn = null;
  shuttingDown = false;
}
