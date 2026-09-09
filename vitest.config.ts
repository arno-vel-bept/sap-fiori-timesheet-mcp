import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Browser-driven login tests are timing sensitive; keep files sequential for deterministic runs.
    fileParallelism: false,
  },
});
