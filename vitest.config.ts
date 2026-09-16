import { defineConfig } from "vitest/config";
import { TEST_FILES } from "./scripts/test-suite.mjs";

export default defineConfig({
  test: {
    include: [...TEST_FILES],
    fileParallelism: false,
  },
});
