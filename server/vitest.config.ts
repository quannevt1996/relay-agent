import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // node:sqlite still prints an ExperimentalWarning on Node 22.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
