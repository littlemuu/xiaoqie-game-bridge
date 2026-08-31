import { spawn } from "node:child_process";
import { fixedWorkerLaunchSpec } from "../../src/adapters/mock/process-mock-adapter.js";

const spec = fixedWorkerLaunchSpec();
const launcher = spawn(spec.executable, spec.argv, {
  cwd: spec.cwd,
  env: spec.env,
  shell: spec.shell,
  windowsHide: true,
  stdio: ["pipe", "pipe", "ignore"],
});
let stdout = "";
launcher.stdout!.setEncoding("utf8");
launcher.stdout!.on("data", (chunk: string) => {
  stdout += chunk;
  if (!stdout.includes("\n")) return;
  process.send?.({ type: "launcher-ready", launcherPid: launcher.pid });
  setImmediate(() => process.exit(0));
});
setTimeout(() => process.exit(2), 2_000).unref();
