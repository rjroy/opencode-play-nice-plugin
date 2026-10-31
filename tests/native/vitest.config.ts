import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/native/prompt-admission.native.test.ts", "tests/native/assembled-plugin.native.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 45000,
    hookTimeout: 15000,
  },
});
