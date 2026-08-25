import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/tests/**/*.test.ts", "server/tests/**/*.test.tsx"],
    // Git-heavy fixtures (real repo creation per test) are CPU/disk-bound
    // and this host runs the suite near its limits; the previous 20s
    // ceiling produced nondeterministic timeouts under sustained load.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(here, "shared"),
    },
  },
});
