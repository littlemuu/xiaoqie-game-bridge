import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_ACTION = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}|\.\/[A-Za-z0-9_./-]+)$/u;
const writes = (permissions) => permissions === "write-all" || Object.values(permissions ?? {}).includes("write");
const commands = (job) => (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

export function validateWorkflowPolicy(repositoryRoot = root) {
  const directory = join(repositoryRoot, ".github", "workflows");
  const names = readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name)).sort();
  if (names.length === 0) throw new Error("No workflows found.");
  const errors = [];
  let release;
  for (const name of names) {
    const document = parseDocument(readFileSync(join(directory, name), "utf8"));
    if (document.errors.length) throw new Error(`${name}: invalid workflow YAML`);
    const workflow = document.toJS({ maxAliasCount: 0 });
    if (workflow?.permissions?.contents !== "read" || writes(workflow.permissions)) errors.push(`${name}: top-level contents: read only is required`);
    const events = typeof workflow.on === "string" ? [workflow.on] : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
    if (events.includes("pull_request_target")) errors.push(`${name}: pull_request_target is forbidden`);
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (writes(job.permissions) && !(name === "release.yml" && jobName === "publish")) errors.push(`${name}: ordinary/build job must not receive write permissions`);
      for (const step of job.steps ?? []) {
        if (step.uses !== undefined && (typeof step.uses !== "string" || !PINNED_ACTION.test(step.uses))) errors.push(`${name}: uses entry must be a pinned action or local action`);
        if (/(?:curl|wget)[^\n|]*\|\s*(?:sh|bash|pwsh|powershell)\b/iu.test(step.run ?? "")) errors.push(`${name}: pipe-to-shell is forbidden`);
      }
    }
    if (name === "release.yml") release = workflow;
  }
  if (!release) errors.push("release.yml: required release workflow is missing");
  else {
    if (JSON.stringify(release.on) !== JSON.stringify({ push: { tags: ["v*-rc.*"] } })) errors.push("release.yml: tag-only release trigger is required");
    const build = release.jobs?.build;
    const publish = release.jobs?.publish;
    if (!build || !publish) errors.push("release.yml: distinct build and publish jobs are required");
    if (JSON.stringify(build?.permissions) !== JSON.stringify({ contents: "read" })) errors.push("release.yml: build job must explicitly use contents: read only");
    if (publish?.needs !== "build") errors.push("release.yml: publish job must depend on build");
    const permissionKeys = ["contents", "id-token", "attestations"];
    if (permissionKeys.some((key) => publish?.permissions?.[key] !== "write") || Object.keys(publish?.permissions ?? {}).length !== permissionKeys.length) errors.push("release.yml: publish permissions must be limited to release and attestation writes");
    const hasAction = (job, action) => (job?.steps ?? []).some((step) => step.uses?.startsWith(`${action}@`));
    if (!hasAction(build, "actions/upload-artifact")) errors.push("release.yml: build job must upload exact evidence");
    if (!hasAction(publish, "actions/download-artifact")) errors.push("release.yml: publish job must download build evidence");
    for (const job of [build, publish]) {
      const text = (job?.steps ?? []).map((step) => `${JSON.stringify(step.env ?? {})}\n${step.run ?? ""}`).join("\n");
      for (const gate of [/github\.ref_protected/u, /git rev-parse HEAD/u, /git cat-file -t/u, /git rev-list -n 1/u]) {
        if (!gate.test(text)) errors.push("release.yml: missing protected annotated tag identity gate");
      }
    }
    const text = commands(publish);
    if (/\b(?:npm|npx|pnpm|yarn)(?:\.cmd)?\b/iu.test(text)) errors.push("release.yml: publish job must not execute dependency or general project lifecycle commands");
    if (!/node scripts\/release\.mjs verify/u.test(text)) errors.push("release.yml: publish job must run the narrow release verifier");
    if (!/gh attestation verify/u.test(text)) errors.push("release.yml: missing post-upload attestation verification");
    const steps = publish?.steps ?? [];
    const attest = steps.findIndex((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
    const create = steps.findIndex((step) => /gh release create/u.test(step.run ?? ""));
    const finish = steps.findIndex((step) => /gh release edit/u.test(step.run ?? ""));
    if (!(attest >= 0 && create > attest && finish > create) || !/--draft\b/u.test(steps[create]?.run ?? "")) errors.push("release.yml: attest, draft upload, and publish order is invalid");
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { schema: "xiaoqie.workflow-policy/v1", verified: true, workflows: names };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(validateWorkflowPolicy())}\n`); }
  catch (error) {
    process.stderr.write(`Workflow policy failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
