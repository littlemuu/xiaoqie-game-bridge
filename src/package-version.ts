import { readFileSync } from "node:fs";

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}

const packageFile = import.meta.url.endsWith(".ts")
  ? new URL("../package.json", import.meta.url)
  : new URL("../../package.json", import.meta.url);
const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as PackageMetadata;

if (
  metadata.name !== "xiaoqie-game-bridge" ||
  typeof metadata.version !== "string" ||
  !/^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(metadata.version)
) {
  throw new TypeError("The package metadata version is invalid.");
}

export const PACKAGE_VERSION = metadata.version;
