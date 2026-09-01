#!/usr/bin/env node
import { buildRelease, verifyRelease } from "./release-lib.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const command = process.argv[2];
const outputDirectory = option("--output");
const expectedCommit = option("--expected-commit");
const expectedRef = option("--expected-ref");

try {
  if (command === "build") {
    const result = buildRelease({ outputDirectory, commit: expectedCommit, ref: expectedRef });
    const verified = verifyRelease({ outputDirectory: result.outputDirectory, expectedCommit, expectedRef });
    process.stdout.write(`${JSON.stringify({
      schema: "xiaoqie.release-result/v1",
      version: verified.manifest.version,
      bundle: verified.manifest.bundle,
      sbom: verified.manifest.sbom,
      provenance: verified.manifest.provenance,
    })}\n`);
  } else if (command === "verify") {
    const verified = verifyRelease({ outputDirectory, expectedCommit, expectedRef });
    process.stdout.write(`${JSON.stringify({ schema: "xiaoqie.release-verification/v1", verified: true, bundle: verified.manifest.bundle })}\n`);
  } else if (command === "version") {
    const verifiedPackage = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${JSON.stringify({ schema: "xiaoqie.release-version/v1", version: verifiedPackage.version })}\n`);
  } else {
    throw new Error("Usage: release.mjs <build|verify|version> [--output DIR] [--expected-commit SHA] [--expected-ref REF]");
  }
} catch (error) {
  process.stderr.write(`Release operation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}
