#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USES_KEY = /^\s*(?:-\s*)?(?:uses|"uses"|'uses')\s*:/u;
const LOCAL_USES = /^\s*(?:-\s*)?uses:\s*(\.\/[A-Za-z0-9_./-]+)\s*$/u;
const EXTERNAL_USES = /^\s*(?:-\s*)?uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})\s+#\s*(v\d+(?:\.\d+){1,2}(?:[-.][A-Za-z0-9.]+)?)\s*$/u;
const WRITE_PERMISSION = /\b(?:contents|packages|actions|checks|deployments|id-token|attestations):\s*write\b/u;

export function validateWorkflowPolicy(repositoryRoot = root) {
  const directory = join(repositoryRoot, ".github", "workflows");
  const names = readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name)).sort();
  if (names.length === 0) throw new Error("No workflows found.");
  const errors = [];
  let releaseText;
  for (const name of names) {
    const text = readFileSync(join(directory, name), "utf8");
    if (/\bpull_request_target\s*:/u.test(text)) errors.push(`${name}: pull_request_target is forbidden`);
    if (/(?:curl|wget)[^\n|]*\|\s*(?:sh|bash|pwsh|powershell)\b/iu.test(text)) errors.push(`${name}: pipe-to-shell is forbidden`);
    if (!/^permissions:\s*\r?\n\s{2}contents:\s*read\s*$/mu.test(text)) errors.push(`${name}: top-level contents: read is required`);
    for (const line of text.split(/\r?\n/u)) {
      if (!USES_KEY.test(line)) continue;
      if (LOCAL_USES.test(line) || EXTERNAL_USES.test(line)) continue;
      errors.push(`${name}: uses entry is outside the closed pinned-action format: ${line.trim()}`);
    }
    if (WRITE_PERMISSION.test(text) && name !== "release.yml") {
      errors.push(`${name}: ordinary workflow contains write permission`);
    }
    if (name === "release.yml") releaseText = text;
  }
  if (releaseText === undefined) errors.push("release.yml: required release workflow is missing");
  else {
    const buildIndex = releaseText.indexOf("\n  build:\n");
    const publishIndex = releaseText.indexOf("\n  publish:\n");
    if (!(buildIndex >= 0 && publishIndex > buildIndex)) errors.push("release.yml: distinct build and publish jobs are required");
    const buildText = buildIndex >= 0 && publishIndex > buildIndex ? releaseText.slice(buildIndex, publishIndex) : "";
    const publishText = publishIndex >= 0 ? releaseText.slice(publishIndex) : "";
    const required = [
      [/^\s{4}tags:\s*\["v\*-rc\.\*"\]\s*$/mu, "release tag trigger"],
      [/\bcontents:\s*write\b/u, "contents write permission"],
      [/\bid-token:\s*write\b/u, "id-token write permission"],
      [/\battestations:\s*write\b/u, "attestations write permission"],
      [/github\.ref_protected/u, "protected-ref gate"],
      [/git rev-parse HEAD/u, "checkout HEAD gate"],
      [/git cat-file -t/u, "annotated-tag gate"],
      [/git rev-list -n 1/u, "tag target gate"],
      [/actions\/attest-build-provenance@[0-9a-f]{40}/u, "GitHub attestation action"],
      [/gh release create/u, "draft release creation"],
      [/--draft/u, "draft-before-verification gate"],
      [/gh attestation verify/u, "post-upload attestation verification"],
      [/gh release edit/u, "final publish step"],
    ];
    for (const [pattern, label] of required) if (!pattern.test(releaseText)) errors.push(`release.yml: missing ${label}`);
    if (/\bpull_request\s*:/u.test(releaseText)) errors.push("release.yml: PR context may not enter the release path");
    if (!/^\s{4}permissions:\s*\r?\n\s{6}contents:\s*read\s*$/mu.test(buildText)) errors.push("release.yml: build job must explicitly use contents: read only");
    if (WRITE_PERMISSION.test(buildText)) errors.push("release.yml: build job must not receive write permissions");
    if (!/^\s{4}needs:\s*build\s*$/mu.test(publishText)) errors.push("release.yml: publish job must depend on build");
    if (!/actions\/upload-artifact@[0-9a-f]{40}/u.test(buildText)) errors.push("release.yml: build job must upload exact evidence");
    if (!/actions\/download-artifact@[0-9a-f]{40}/u.test(publishText)) errors.push("release.yml: publish job must download build evidence");
    if (/\b(?:npm|npx|pnpm|yarn)(?:\.cmd)?\b/iu.test(publishText)) errors.push("release.yml: publish job must not execute dependency or general project lifecycle commands");
    if (!/node scripts\/release\.mjs verify/u.test(publishText)) errors.push("release.yml: publish job must run only the narrow release verifier");
    if (WRITE_PERMISSION.test(releaseText.slice(0, Math.max(0, publishIndex)))) errors.push("release.yml: write permissions must exist only in the publish job");
    const create = publishText.indexOf("gh release create");
    const attest = publishText.indexOf("actions/attest-build-provenance@");
    const publish = publishText.indexOf("gh release edit");
    if (!(attest >= 0 && create > attest && publish > create)) errors.push("release.yml: attest, draft upload, and publish order is invalid");
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { schema: "xiaoqie.workflow-policy/v1", verified: true, workflows: names };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(validateWorkflowPolicy())}\n`);
  } catch (error) {
    process.stderr.write(`Workflow policy failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
