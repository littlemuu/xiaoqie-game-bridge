import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedWorkerLaunchSpec } from "../../src/adapters/mock/process-mock-adapter.js";

const spec = fixedWorkerLaunchSpec({
  testOnly: { faultMode: "hang", containmentFaultStage: "none" },
});
const probeWorkerPath = fileURLToPath(new URL("./containment-probe-worker.js", import.meta.url));
const launcher = spawn(spec.executable, [
  process.execPath,
  probeWorkerPath,
  "probe-parent-liveness",
  "none",
], {
  cwd: dirname(probeWorkerPath),
  env: spec.env,
  shell: spec.shell,
  windowsHide: true,
  stdio: ["pipe", "pipe", "ignore"],
});
let stdout = "";
let announced = false;
launcher.stdout!.setEncoding("utf8");
launcher.stdout!.on("data", (chunk: string) => {
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf("\n");
    if (newline < 0) break;
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    const message = JSON.parse(line) as { type?: string };
    if (announced || message.type !== "probe-parent-ready") continue;
    announced = true;
    process.send?.({
      type: "launcher-ready",
      launcherPid: launcher.pid,
    });
    setImmediate(() => process.exit(0));
  }
});
setTimeout(() => process.exit(2), 2_000).unref();
