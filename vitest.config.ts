import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites start wrangler dev. Run files one at a time so they do not starve each other.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
