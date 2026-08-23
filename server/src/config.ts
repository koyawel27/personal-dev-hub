import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "..", "..");

export const config = {
  host: "127.0.0.1" as const,
  gitTimeoutMs: 20_000,
  clientDist: path.join(PROJECT_ROOT, "dist", "client"),
  get port(): number {
    return Number(process.env.DASHBOARD_PORT) || 8787;
  },
  get dbPath(): string {
    return (
      process.env.DASHBOARD_DB_PATH ||
      path.join(PROJECT_ROOT, "data", "dashboard.sqlite")
    );
  },
};
