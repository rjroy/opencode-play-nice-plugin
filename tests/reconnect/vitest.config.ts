import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    environment: "node", include: ["tests/reconnect/pn-term-1.test.ts"],
    fileParallelism: false, maxWorkers: 1, testTimeout: 15000,
  },
});
