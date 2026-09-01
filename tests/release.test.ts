import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { evidenceStatusFor, FULL_SUITE_FILES, summarizeVitest } from "../scripts/windows-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

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
      expectedCommit: result.manifest.source.commit,
      expectedRef: result.manifest.source.ref,
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

  it("rejects false expected source identity before emitting evidence", () => {
    const wrongCommitOutput = temporaryDirectory("xiaoqie-release-wrong-commit-");
    expect(() => buildRelease({
      root,
      outputDirectory: wrongCommitOutput,
      allowDirty: true,
      skipCompile: true,
      expectedCommit: "f".repeat(40),
    })).toThrow(/does not match checkout HEAD/u);
    expect(readdirSync(wrongCommitOutput)).toEqual([]);

    const wrongRefOutput = temporaryDirectory("xiaoqie-release-wrong-ref-");
    expect(() => buildRelease({
      root,
      outputDirectory: wrongRefOutput,
      allowDirty: true,
      skipCompile: true,
      expectedCommit: commit,
      expectedRef: "refs/heads/not-the-checkout",
    })).toThrow(/does not match the checkout symbolic ref/u);
    expect(readdirSync(wrongRefOutput)).toEqual([]);
  });

  it("records the numeric GitHub PR merge ref without opening the ref format", () => {
    const checkout = temporaryDirectory("xiaoqie-release-pr-checkout-");
    execFileSync("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", root, checkout]);
    execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: checkout });
    execFileSync("git", ["update-ref", "refs/remotes/pull/18/merge", commit], { cwd: checkout });
    cpSync(join(root, "dist"), join(checkout, "dist"), { recursive: true });
    const outputDirectory = temporaryDirectory("xiaoqie-release-pr-ref-");
    const result = buildRelease({
      root: checkout,
      outputDirectory,
      allowDirty: true,
      skipCompile: true,
      expectedCommit: commit,
      expectedRef: "refs/pull/18/merge",
    });
    expect(verifyRelease({ root: checkout, outputDirectory: result.outputDirectory, expectedRef: "refs/pull/18/merge" }).manifest.source.ref)
      .toBe("refs/pull/18/merge");
    expect(() => buildRelease({
      root: checkout,
      outputDirectory,
      allowDirty: true,
      skipCompile: true,
      expectedCommit: commit,
      expectedRef: "refs/pull/not-a-number/merge",
    })).toThrow(/ref is outside/u);
  });

  it("requires an annotated tag that peels to checkout HEAD", () => {
    const checkout = temporaryDirectory("xiaoqie-release-tag-checkout-");
    execFileSync("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", root, checkout]);
    execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: checkout });
    execFileSync("git", ["-c", "user.name=release-test", "-c", "user.email=release-test@example.invalid", "tag", "-a", "v0.1.0-rc.1-test", "-m", "test tag", commit], { cwd: checkout });
    cpSync(join(root, "dist"), join(checkout, "dist"), { recursive: true });
    const result = buildRelease({
      root: checkout,
      outputDirectory: temporaryDirectory("xiaoqie-release-tag-output-"),
      allowDirty: true,
      skipCompile: true,
      expectedCommit: commit,
      expectedRef: "refs/tags/v0.1.0-rc.1-test",
    });
    expect(result.manifest.source).toMatchObject({ commit, ref: "refs/tags/v0.1.0-rc.1-test" });
    expect(() => buildRelease({
      root: checkout,
      outputDirectory: temporaryDirectory("xiaoqie-release-missing-tag-"),
      allowDirty: true,
      skipCompile: true,
      expectedCommit: commit,
      expectedRef: "refs/tags/missing",
    })).toThrow();
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
    expect(() => validateWorkflowPolicy(fixture)).toThrow(/closed pinned-action|ordinary workflow/u);
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

  it("rejects every quoted, floating, expression, Docker, or malformed uses entry", () => {
    const replacements = [
      '      - uses: "actions/checkout@v7"',
      "      - uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' # v7.0.1",
      "      - uses: ${{ matrix.action }}",
      "      - uses: docker://alpine:latest",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      '      - "uses": actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    ];
    for (const replacement of replacements) {
      const fixture = temporaryDirectory("xiaoqie-uses-policy-");
      cpSync(join(root, ".github"), join(fixture, ".github"), { recursive: true });
      const checkPath = join(fixture, ".github", "workflows", "check.yml");
      const check = readFileSync(checkPath, "utf8").replace(
        /^\s*- uses: actions\/checkout@[0-9a-f]{40} # v7\.0\.1\s*$/mu,
        replacement,
      );
      writeFileSync(checkPath, check);
      expect(() => validateWorkflowPolicy(fixture), replacement).toThrow(/closed pinned-action/u);
    }
  });

  it("enforces read-only build and a dependent lifecycle-free publish job", () => {
    const lifecycleFixture = temporaryDirectory("xiaoqie-publish-lifecycle-");
    cpSync(join(root, ".github"), join(lifecycleFixture, ".github"), { recursive: true });
    const lifecyclePath = join(lifecycleFixture, ".github", "workflows", "release.yml");
    const lifecycle = readFileSync(lifecyclePath, "utf8")
      .replace("    needs: build", "    needs: missing")
      .replace(/(\n  publish:[\s\S]*?\n    steps:\n)/u, "$1      - run: npm ci\n");
    writeFileSync(lifecyclePath, lifecycle);
    expect(() => validateWorkflowPolicy(lifecycleFixture)).toThrow(/depend on build|must not execute/u);

    const writeFixture = temporaryDirectory("xiaoqie-build-write-");
    cpSync(join(root, ".github"), join(writeFixture, ".github"), { recursive: true });
    const writePath = join(writeFixture, ".github", "workflows", "release.yml");
    const release = readFileSync(writePath, "utf8").replace(
      "  build:\n    if: github.ref_type == 'tag'\n    runs-on: ubuntu-latest\n    timeout-minutes: 25\n    permissions:\n      contents: read",
      "  build:\n    if: github.ref_type == 'tag'\n    runs-on: ubuntu-latest\n    timeout-minutes: 25\n    permissions:\n      contents: write",
    );
    writeFileSync(writePath, release);
    expect(() => validateWorkflowPolicy(writeFixture)).toThrow(/build job must/u);
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

  it("rejects zero assertions and one unrelated passing assertion as full evidence", () => {
    const empty = summarizeVitest({ testResults: [] }, "full");
    expect(empty).toMatchObject({ total: 0, passed: 0, inventory: { complete: false } });
    expect(evidenceStatusFor({ platform: "win32", elevated: false, clean: true, vitest: empty, containmentVerified: true }))
      .toBe("unverified");

    const unrelated = summarizeVitest({
      testResults: [{ name: "unrelated.test.ts", assertionResults: [{ title: "passes", status: "passed" }] }],
    }, "full");
    expect(unrelated).toMatchObject({ passed: 1, inventory: { complete: false, unexpectedFileCount: 1 } });
    expect(evidenceStatusFor({ platform: "win32", elevated: false, clean: true, vitest: unrelated, containmentVerified: true }))
      .toBe("unverified");
  });

  it("rejects missing categories and duplicate test-file results", () => {
    const missing = summarizeVitest({
      testResults: [{ name: "bridge.test.ts", assertionResults: [{ title: "passes", status: "passed" }] }],
    }, "full");
    expect(missing.inventory.complete).toBe(false);
    expect(missing.inventory.missingRequiredCategories).toContain("windows-containment");

    const duplicate = summarizeVitest({
      testResults: [
        { name: "bridge.test.ts", assertionResults: [{ title: "one", status: "passed" }] },
        { name: "bridge.test.ts", assertionResults: [{ title: "two", status: "passed" }] },
      ],
    }, "full");
    expect(duplicate.inventory).toMatchObject({ complete: false, duplicateFileCount: 1 });
  });

  it("accepts only the exact versioned full-suite inventory for non-elevated evidence", () => {
    const testResults = FULL_SUITE_FILES.map((name) => ({
      name,
      assertionResults: [{ ancestorTitles: [name], title: "required check", status: "passed" }],
    }));
    testResults.find((result) => result.name === "windows-containment.test.ts")!.assertionResults.push({
      ancestorTitles: ["platform containment gate"],
      title: "inapplicable alternate platform",
      status: "pending",
    });
    const full = summarizeVitest({ testResults }, "full");
    expect(full.inventory).toMatchObject({ complete: true, missingFiles: [], missingRequiredCategories: [] });
    expect(evidenceStatusFor({ platform: "win32", elevated: false, clean: true, vitest: full, containmentVerified: true }))
      .toBe("verified-with-explicit-inapplicable-skips");
    expect(evidenceStatusFor({ platform: "win32", elevated: false, clean: true, vitest: full, containmentVerified: false }))
      .toBe("unverified");
  });

  it("keeps the exact targeted hosted suite scoped to elevated fail-closed", () => {
    const targeted = summarizeVitest({
      testResults: [{
        name: "windows-containment.test.ts",
        assertionResults: [{ ancestorTitles: ["elevated Windows host gate"], title: "rejects", status: "passed" }],
      }],
    }, "elevated-gate");
    expect(targeted.inventory.complete).toBe(true);
    expect(evidenceStatusFor({ platform: "win32", elevated: true, clean: true, vitest: targeted, containmentVerified: false }))
      .toBe("elevated-fail-closed-only");
    expect(evidenceStatusFor({ platform: "win32", elevated: false, clean: true, vitest: targeted, containmentVerified: true }))
      .toBe("unverified");
  });
});
