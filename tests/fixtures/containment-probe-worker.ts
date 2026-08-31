import { spawn } from "node:child_process";

const mode = process.env.XIAOQIE_TEST_MODE;

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

write({ version: 1, type: "probe-entry", mode });

switch (mode) {
  case "probe-attestation":
    process.exit(0);
    break;
  case "probe-child": { // The Job's active-process limit must reject this kernel request.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      env: {},
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const deadline = setTimeout(() => {
      child.kill();
      process.exit(9);
    }, 1_000);
    child.once("error", () => {
      clearTimeout(deadline);
      write({ version: 1, type: "probe-child-result", denied: true });
      process.exit(0);
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      const denied = code !== 0;
      write({ version: 1, type: "probe-child-result", denied });
      process.exit(denied ? 0 : 8);
    });
    break;
  }
  case "probe-memory": { // Bounded allocations; the 128 MiB process limit must terminate first.
    const allocations: Buffer[] = [];
    for (let index = 0; index < 32; index += 1) {
      allocations.push(Buffer.alloc(8 * 1_024 * 1_024, 0xa5));
    }
    write({ version: 1, type: "probe-memory-result", limited: false });
    process.exit(7);
    break;
  }
  case "probe-cpu": { // Deliberately bounded; policy evidence comes from the trusted Job query.
    const deadline = performance.now() + 500;
    let operations = 0;
    while (performance.now() < deadline) operations += 1;
    write({ version: 1, type: "probe-cpu-result", completed: operations > 0 });
    process.exit(0);
    break;
  }
  default:
    process.exit(6);
}
