import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One discovery rule shared by Vitest and the optional release evidence report.
const directory = fileURLToPath(new URL("../tests/", import.meta.url));
export const TEST_FILES = Object.freeze(readdirSync(directory, { recursive: true })
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `tests/${name.replaceAll("\\", "/")}`)
  .sort());
