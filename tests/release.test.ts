import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRelease,
  readCanonicalTarGzip,
  sha256,
  verifyRelease,
} from "../scripts/release-lib.mjs";
import { validateWorkflowPolicy } from "../scripts/workflow-policy.mjs";
import { summarizeVitest } from "../scripts/windows-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];
const commit = "0123456789abcdef0123456789abcdef01234567";
const ref = "refs/heads/release-test";

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function build(directory: string) {
  return buildRelease({
    root,
    outputDirectory: directory,
    allowDirty: true,
    skipCompile: true,
    commit,
    ref,
  });
}

function rewriteEvidence(directory: string, mutate: (manifest: any, provenance: any) => void): void {
  const prefix = "xiaoqie-game-bridge-0.1.0-rc.1";
  const manifestPath = join(directory, `${prefix}.release-manifest.json`);
  const provenancePath = join(directory, `${prefix}.provenance.json`);
  const checksumPath = join(directory, `${prefix}.sha256`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  mutate(manifest, provenance);
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(provenancePath, provenanceBytes);
  manifest.provenance.sha256 = sha256(provenanceBytes);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, manifestBytes);
  const files = [
    `${prefix}.tar.gz`,
    `${prefix}.release-manifest.json`,
    `${prefix}.provenance.json`,
    `${prefix}.sbom.cdx.json`,
  ].sort();
  writeFileSync(checksumPath, `${files.map((name) => `${sha256(readFileSync(join(directory, name)))}  ${name}`).join("\n")}\n`);
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("canonical release evidence", () => {
  it("produces the same bundle from two independent output roots", () => {
    const first = build(temporaryDirectory("xiaoqie-release-a-"));
    const second = build(temporaryDirectory("xiaoqie-release-b-"));
    expect(first.manifest.bundle).toEqual(second.manifest.bundle);
    expect(readFileSync(join(first.outputDirectory, first.manifest.bundle.name)))
      .toEqual(readFileSync(join(second.outputDirectory, second.manifest.bundle.name)));
  });

  it("uses an exact source-and-runtime allowlist without native binaries or local output", () => {
    const result = build(temporaryDirectory("xiaoqie-release-allowlist-"));
    const archive = readCanonicalTarGzip(readFileSync(join(result.outputDirectory, result.manifest.bundle.name)));
    const paths = archive.map((entry) => entry.path);
    expect(paths).toContain("xiaoqie-game-bridge-0.1.0-rc.1/native/windows-worker-launcher.cpp");
    expect(paths).toContain("xiaoqie-game-bridge-0.1.0-rc.1/dist/src/mcp/stdio-server.js");
    expect(archive.find((entry) => entry.path.endsWith("/.nvmrc"))?.data.toString("utf8"))
      .toBe("22.23.1\n");
    expect(paths.some((path) => /(?:\.exe|\.dll|node_modules|\.git|coverage|\.log|\.env)/iu.test(path))).toBe(false);
    expect(result.manifest.files.map((file: { path: string }) => file.path))
      .toEqual(paths.map((path) => path.replace("xiaoqie-game-bridge-0.1.0-rc.1/", "")));
  });

  it("parses and cross-checks the manifest, checksum, SBOM, and provenance", () => {
    const result = build(temporaryDirectory("xiaoqie-release-verify-"));
    const verified = verifyRelease({
      root,
      outputDirectory: result.outputDirectory,
      expectedCommit: commit,
      expectedRef: ref,
    });
    expect(verified.manifest.sbom.format).toBe("CycloneDX-1.6-json");
    expect(verified.manifest.provenance.signedAttestation).toBe(false);
  });

  it("fails stably when any bundle byte is changed", () => {
    const result = build(temporaryDirectory("xiaoqie-release-tamper-"));
    const path = join(result.outputDirectory, result.manifest.bundle.name);
    const bytes = readFileSync(path);
    bytes[Math.floor(bytes.length / 2)]! ^= 1;
    writeFileSync(path, bytes);
    expect(() => verifyRelease({ root, outputDirectory: result.outputDirectory })).toThrow(/Checksum mismatch/u);
  });

  it("fails closed for an incorrect expected ref or commit", () => {
    const result = build(temporaryDirectory("xiaoqie-release-source-"));
    expect(() => verifyRelease({ root, outputDirectory: result.outputDirectory, expectedRef: "refs/tags/wrong" })).toThrow(/expected ref/u);
    expect(() => verifyRelease({ root, outputDirectory: result.outputDirectory, expectedCommit: "f".repeat(40) })).toThrow(/expected commit/u);
  });

  it("fails closed when provenance names the wrong bundle digest", () => {
    const result = build(temporaryDirectory("xiaoqie-release-provenance-"));
    rewriteEvidence(result.outputDirectory, (_manifest, provenance) => {
      provenance.subject[0].digest.sha256 = "f".repeat(64);
    });
    expect(() => verifyRelease({ root, outputDirectory: result.outputDirectory })).toThrow(/Provenance subject/u);
  });
});

describe("workflow release boundary", () => {
  it("pins actions and keeps release writes behind the tag-only workflow", () => {
    expect(validateWorkflowPolicy(root)).toMatchObject({ verified: true, workflows: ["check.yml", "release.yml"] });
  });

  it("rejects floating actions and ordinary-workflow write permissions", () => {
    const fixture = temporaryDirectory("xiaoqie-workflow-policy-");
    cpSync(join(root, ".github"), join(fixture, ".github"), { recursive: true });
    const checkPath = join(fixture, ".github", "workflows", "check.yml");
    const check = readFileSync(checkPath, "utf8")
      .replace(/actions\/checkout@[0-9a-f]{40}/u, "actions/checkout@v7")
      .replace("permissions:\n  contents: read", "permissions:\n  contents: write");
    writeFileSync(checkPath, check);
    expect(() => validateWorkflowPolicy(fixture)).toThrow(/not pinned|ordinary workflow/u);
  });

  it("rejects PR-triggered or incomplete release paths", () => {
    const fixture = temporaryDirectory("xiaoqie-release-policy-");
    cpSync(join(root, ".github"), join(fixture, ".github"), { recursive: true });
    const releasePath = join(fixture, ".github", "workflows", "release.yml");
    const release = readFileSync(releasePath, "utf8")
      .replace("  push:\n    tags:", "  pull_request:\n  push:\n    tags:")
      .replace("gh attestation verify", "gh verification-disabled");
    writeFileSync(releasePath, release);
    expect(() => validateWorkflowPolicy(fixture)).toThrow(/PR context|attestation verification/u);
  });
});

describe("Windows evidence accounting", () => {
  it("does not summarize skipped, failed, or unknown results as a complete pass", () => {
    const summary = summarizeVitest({
      testResults: [{ assertionResults: [
        { ancestorTitles: ["real Windows worker containment"], title: "one", status: "passed" },
        { ancestorTitles: ["elevated Windows host gate"], title: "two", status: "pending" },
        { ancestorTitles: ["other"], title: "three", status: "failed", failureMessages: ["C:\\Users\\attacker\\secret"] },
        { ancestorTitles: ["other"], title: "four", status: "mystery", failureMessages: ["Bearer-do-not-copy"] },
      ] }],
    });
    expect(summary).toMatchObject({ total: 4, passed: 1, failed: 1, skipped: 1, unknown: 1, allRegisteredTestsPassed: false });
    expect(JSON.stringify(summary)).not.toContain("attacker");
    expect(JSON.stringify(summary)).not.toContain("Bearer");
  });
});
