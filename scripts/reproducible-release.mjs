#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rootDirectory, safeRelative } from "./release-lib.mjs";

const root = rootDirectory();

function run(cwd, command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail === "" ? "." : `: ${detail}`}`);
  }
  return String(result.stdout).trim();
}

function git(cwd, args) {
  return run(cwd, "git", args);
}

function manifest(checkout) {
  const packageJson = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  return JSON.parse(readFileSync(join(checkout, "release-out", `${packageJson.name}-${packageJson.version}.release-manifest.json`), "utf8"));
}

let temporaryRoot;
try {
  if (process.versions.node.split(".")[0] !== "22") throw new Error("Canonical reproducibility requires Node.js 22.");
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") throw new Error("Reproducibility comparison requires a clean source tree.");
  const commit = git(root, ["rev-parse", "HEAD"]);
  const ref = process.env.GITHUB_REF ?? (() => {
    try { return git(root, ["symbolic-ref", "-q", "HEAD"]); } catch { return `detached/${commit}`; }
  })();
  temporaryRoot = mkdtempSync(join(tmpdir(), "xiaoqie-release-repro-"));
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli !== "string" || npmCli === "") throw new Error("Reproducibility must be invoked through npm so npm_execpath is fixed.");
  const environment = { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" };
  const manifests = [];
  for (const name of ["checkout-a", "checkout-b"]) {
    const checkout = join(temporaryRoot, name);
    run(temporaryRoot, "git", ["clone", "--quiet", "--no-local", "--no-hardlinks", root, checkout]);
    git(checkout, ["checkout", "--quiet", "--detach", commit]);
    run(checkout, process.execPath, [npmCli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], environment);
    run(checkout, process.execPath, ["scripts/release.mjs", "build", "--expected-commit", commit, "--expected-ref", ref], environment);
    manifests.push(manifest(checkout));
  }
  const [first, second] = manifests;
  if (first.bundle.sha256 !== second.bundle.sha256 || first.bundle.bytes !== second.bundle.bytes) {
    throw new Error("Independent clean checkouts produced different canonical bundle digests.");
  }
  run(root, process.execPath, ["scripts/release.mjs", "build", "--expected-commit", commit, "--expected-ref", ref], environment);
  const checkoutManifest = manifest(root);
  if (checkoutManifest.bundle.sha256 !== first.bundle.sha256 || checkoutManifest.bundle.bytes !== first.bundle.bytes) {
    throw new Error("The release checkout bundle does not match both independent clean builds.");
  }
  process.stdout.write(`${JSON.stringify({
    schema: "xiaoqie.reproducibility/v1",
    verified: true,
    commit,
    ref,
    builds: 2,
    releaseCheckoutMatched: true,
    bundle: first.bundle,
  })}\n`);
} catch (error) {
  process.stderr.write(`Reproducibility check failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryRoot !== undefined) {
    safeRelative(tmpdir(), temporaryRoot);
    rmSync(resolve(temporaryRoot), { recursive: true, force: true });
  }
}
