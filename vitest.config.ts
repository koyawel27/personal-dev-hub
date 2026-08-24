import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/tests/**/*.test.ts", "server/tests/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(here, "shared"),
    },
  },
});
