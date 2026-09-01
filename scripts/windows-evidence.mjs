#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS_EVIDENCE_SCHEMA, sha256 } from "./release-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_OUTPUT_NAME = /^[A-Za-z0-9._-]+$/u;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed${detail === "" ? "." : `: ${detail}`}`);
  }
  return String(result.stdout).trim();
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function categoryForAssertion(assertion) {
  const title = [...(assertion.ancestorTitles ?? []), assertion.title ?? ""].join(" ");
  if (/elevated Windows host gate|platform containment gate/iu.test(title)) return "inapplicable-platform-gate";
  if (/real Windows worker containment/iu.test(title)) return "windows-containment";
  if (/operator/iu.test(title)) return "windows-operator";
  if (/process|MCP|stdio/iu.test(title)) return "windows-product-boundary";
  return "platform-neutral-or-unknown";
}

export function summarizeVitest(value) {
  if (typeof value !== "object" || value === null || !Array.isArray(value.testResults)) throw new Error("Vitest JSON report is malformed.");
  const assertions = value.testResults.flatMap((result) => Array.isArray(result.assertionResults) ? result.assertionResults : []);
  const counts = { total: assertions.length, passed: 0, failed: 0, skipped: 0, unknown: 0 };
  const skippedCategories = new Map();
  for (const assertion of assertions) {
    if (assertion.status === "passed") counts.passed += 1;
    else if (assertion.status === "failed") counts.failed += 1;
    else if (["pending", "todo", "disabled", "skipped"].includes(assertion.status)) {
      counts.skipped += 1;
      const category = categoryForAssertion(assertion);
      skippedCategories.set(category, (skippedCategories.get(category) ?? 0) + 1);
    } else counts.unknown += 1;
  }
  if (counts.total !== counts.passed + counts.failed + counts.skipped + counts.unknown) throw new Error("Vitest result accounting mismatch.");
  return {
    ...counts,
    allRegisteredTestsPassed: counts.total > 0 && counts.failed === 0 && counts.skipped === 0 && counts.unknown === 0,
    skippedCategories: [...skippedCategories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => ({ category, count })),
  };
}

function isElevatedWindows() {
  if (process.platform !== "win32") return null;
  const command = "$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'true'}else{'false'}";
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]) === "true";
}

function containmentProbe() {
  const executable = join(root, "dist", "native", "xiaoqie-worker-test-launcher.exe");
  const worker = join(root, "dist", "tests", "fixtures", "containment-probe-worker.js");
  const result = spawnSync(executable, [process.execPath, worker, "probe-attestation", "none"], {
    cwd: dirname(worker),
    env: {},
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("Fixed containment evidence probe failed.");
  const lines = String(result.stdout).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const ready = lines.find((line) => line?.type === "containment-ready");
  const entered = lines.some((line) => line?.type === "probe-entry");
  if (ready === undefined || !entered || typeof ready.attestation !== "object" || ready.attestation === null) throw new Error("Fixed containment evidence probe returned no trusted attestation.");
  const a = ready.attestation;
  const exact = {
    tokenRestricted: true,
    dangerousPrivilegesDisabled: true,
    privilegedGroupsDisabledOrDenyOnly: true,
    restrictingSidPolicy: "source-user-and-enabled-groups",
    integrity: "medium",
    jobAssigned: true,
    killOnClose: true,
    activeProcessLimit: 1,
    processMemoryLimitBytes: 268435456,
    jobMemoryLimitBytes: 201326592,
    cpuRatePercent: 20,
    breakawayAllowed: false,
  };
  for (const [key, value] of Object.entries(exact)) if (a[key] !== value) throw new Error(`Containment attestation mismatch: ${key}`);
  if (!new Set(["nested", "none"]).has(a.hostJob)) throw new Error("Containment host Job status is unknown.");
  return {
    hostJob: a.hostJob === "nested",
    restrictedToken: "verified",
    jobMembership: "verified",
    processPolicy: { activeProcessLimit: 1, memoryBytes: 268435456 },
    jobPolicy: { memoryBytes: 201326592, cpuRatePercent: 20, killOnClose: true, breakawayAllowed: false },
    cleanup: { launcherClosed: true, workerProbeSettled: true, handlesClosed: true, temporaryDirectoriesCreated: 0 },
  };
}

function releaseDigest(directory) {
  const candidates = readdirSync(directory).filter((name) => name.endsWith(".release-manifest.json"));
  if (candidates.length !== 1 || !SAFE_OUTPUT_NAME.test(candidates[0])) throw new Error("Release manifest selection is not closed-world.");
  const manifest = JSON.parse(readFileSync(join(directory, candidates[0]), "utf8"));
  if (typeof manifest.bundle?.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.bundle.sha256)) throw new Error("Release bundle digest is unavailable.");
  return { name: manifest.bundle.name, sha256: manifest.bundle.sha256, sourceCommit: manifest.source?.commit, version: manifest.version };
}

export function generateWindowsEvidence(options) {
  const vitest = summarizeVitest(JSON.parse(readFileSync(resolve(options.testResults), "utf8")));
  const commit = run("git", ["rev-parse", "HEAD"]);
  const clean = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]) === "";
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli !== "string" || npmCli === "") throw new Error("Windows evidence must be invoked through npm so npm_execpath is fixed.");
  const npmVersion = run(process.execPath, [npmCli, "--version"]);
  const elevated = isElevatedWindows();
  let containment = {
    hostJob: "unknown",
    restrictedToken: "not-run",
    jobMembership: "not-run",
    processPolicy: "not-run",
    jobPolicy: "not-run",
    cleanup: { launcherClosed: "not-run", workerProbeSettled: "not-run", handlesClosed: "not-run", temporaryDirectoriesCreated: 0 },
  };
  if (process.platform === "win32" && elevated === false) containment = containmentProbe();
  const bundle = releaseDigest(resolve(options.releaseDirectory));
  if (bundle.sourceCommit !== commit) throw new Error("Bundle source commit does not match the evidence commit.");
  const onlyInapplicableSkips = vitest.skippedCategories.every((entry) => entry.category === "inapplicable-platform-gate");
  const evidenceStatus = process.platform !== "win32" ? "not-windows"
    : !clean ? "unverified"
      : elevated === true && vitest.passed > 0 && vitest.failed === 0 && vitest.unknown === 0 ? "elevated-fail-closed-only"
        : elevated === true ? "unverified"
      : vitest.failed > 0 || vitest.unknown > 0 ? "unverified"
        : vitest.skipped === 0 ? "verified"
          : onlyInapplicableSkips ? "verified-with-explicit-inapplicable-skips" : "unverified";
  const evidence = {
    schema: WINDOWS_EVIDENCE_SCHEMA,
    version: bundle.version,
    source: { commit, clean },
    environment: {
      platform: process.platform,
      windowsVersion: process.platform === "win32" ? release() : "not-windows",
      architecture: arch(),
      node: process.version,
      npm: npmVersion,
      elevated,
      inHostJob: containment.hostJob,
      elevatedFailClosed: elevated === true && evidenceStatus === "elevated-fail-closed-only",
    },
    tests: vitest,
    containment: {
      restrictedToken: containment.restrictedToken,
      jobMembership: containment.jobMembership,
      processPolicy: containment.processPolicy,
      jobPolicy: containment.jobPolicy,
    },
    cleanup: containment.cleanup,
    bundle: { name: bundle.name, sha256: bundle.sha256 },
    nonElevatedWindowsEvidence: evidenceStatus,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (/(?:[A-Za-z]:\\|\/(?:home|Users|tmp)\/|"(?:pid|sid|username|tokenHandle|commandLine|stack|secret)"\s*:)/iu.test(serialized)) {
    throw new Error("Evidence report contains a forbidden host identifier field or absolute path.");
  }
  return { evidence, serialized };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const testResults = option("--test-results");
    const releaseDirectory = option("--release-dir");
    const outputDirectory = resolve(option("--output") ?? join(root, "windows-evidence-out"));
    if (testResults === undefined || releaseDirectory === undefined) throw new Error("Usage: windows-evidence.mjs --test-results FILE --release-dir DIR [--output DIR]");
    const { evidence, serialized } = generateWindowsEvidence({ testResults, releaseDirectory });
    mkdirSync(outputDirectory, { recursive: true });
    const jsonName = "windows-evidence-v1.json";
    writeFileSync(join(outputDirectory, jsonName), serialized, { mode: 0o644 });
    const markdown = [
      "# Windows evidence v1",
      "",
      `- Commit: \`${evidence.source.commit}\``,
      `- Clean source: \`${evidence.source.clean}\``,
      `- Environment: \`${evidence.environment.platform}\` / \`${evidence.environment.architecture}\` / Node \`${evidence.environment.node}\` / npm \`${evidence.environment.npm}\``,
      `- Elevated: \`${evidence.environment.elevated}\`; host Job: \`${evidence.environment.inHostJob}\``,
      `- Tests: ${evidence.tests.passed} passed, ${evidence.tests.failed} failed, ${evidence.tests.skipped} skipped, ${evidence.tests.unknown} unknown`,
      `- Non-elevated Windows evidence: \`${evidence.nonElevatedWindowsEvidence}\``,
      `- Bundle SHA-256: \`${evidence.bundle.sha256}\``,
      "",
      "This closed-world report contains no path, PID, SID, username, token handle, command line, stack, secret, or raw failure message.",
      "",
    ].join("\n");
    writeFileSync(join(outputDirectory, "windows-evidence-v1.md"), markdown, { mode: 0o644 });
    process.stdout.write(`${JSON.stringify({ schema: "xiaoqie.windows-evidence-result/v1", generated: true, reportSha256: sha256(serialized), status: evidence.nonElevatedWindowsEvidence })}\n`);
  } catch (error) {
    process.stderr.write(`Windows evidence generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
