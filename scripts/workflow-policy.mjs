#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACTION = /^\s*-?\s*uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s*(.+))?\s*$/gmu;
const FULL_SHA = /^[0-9a-f]{40}$/u;

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
    for (const match of text.matchAll(ACTION)) {
      const [line, action, revision, comment] = match;
      if (action.startsWith("./")) continue;
      if (!FULL_SHA.test(revision)) errors.push(`${name}: action is not pinned to a full SHA: ${line.trim()}`);
      if (comment === undefined || !/^v\d+(?:\.\d+){1,2}(?:[-.][A-Za-z0-9.]+)?$/u.test(comment.trim())) errors.push(`${name}: pinned action lacks a readable version comment: ${action}`);
    }
    if (/\b(?:contents|packages|actions|checks|deployments|id-token|attestations):\s*write\b/u.test(text) && name !== "release.yml") {
      errors.push(`${name}: ordinary workflow contains write permission`);
    }
    if (name === "release.yml") releaseText = text;
  }
  if (releaseText === undefined) errors.push("release.yml: required release workflow is missing");
  else {
    const required = [
      [/^\s{4}tags:\s*\["v\*-rc\.\*"\]\s*$/mu, "release tag trigger"],
      [/\bcontents:\s*write\b/u, "contents write permission"],
      [/\bid-token:\s*write\b/u, "id-token write permission"],
      [/\battestations:\s*write\b/u, "attestations write permission"],
      [/github\.ref_protected/u, "protected-ref gate"],
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
    const create = releaseText.indexOf("gh release create");
    const attest = releaseText.indexOf("actions/attest-build-provenance@");
    const publish = releaseText.indexOf("gh release edit");
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
