import { fork, spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AdapterRunnerError,
  CONTAINMENT_ACTIVE_PROCESS_LIMIT,
  CONTAINMENT_CPU_RATE_PERCENT,
  CONTAINMENT_JOB_MEMORY_LIMIT_BYTES,
  CONTAINMENT_PROCESS_MEMORY_LIMIT_BYTES,
  ProcessMockAdapter,
  containmentReadySchema,
  fixedWorkerLaunchSpec,
  type ContainmentFaultStage,
} from "../src/index.js";

const isWindows = process.platform === "win32";
const probeWorkerPath = fileURLToPath(
  import.meta.url.endsWith(".ts")
    ? new URL("../dist/tests/fixtures/containment-probe-worker.js", import.meta.url)
    : new URL("./fixtures/containment-probe-worker.js", import.meta.url),
);
const launcherParentPath = fileURLToPath(
  import.meta.url.endsWith(".ts")
    ? new URL("../dist/tests/fixtures/launcher-parent.js", import.meta.url)
    : new URL("./fixtures/launcher-parent.js", import.meta.url),
);

interface ProbeRun {
  code: number | null;
  messages: unknown[];
  stderrBytes: number;
  launcherPid: number;
}

async function runProbe(
  mode: "probe-attestation" | "probe-child" | "probe-memory" | "probe-cpu",
  faultStage: ContainmentFaultStage = "none",
): Promise<ProbeRun> {
  const testSpec = fixedWorkerLaunchSpec({
    testOnly: { faultMode: "hang", containmentFaultStage: faultStage },
  });
  const child = spawn(testSpec.executable, [
    process.execPath,
    probeWorkerPath,
    mode,
    faultStage,
  ], {
    cwd: dirname(probeWorkerPath),
    env: {},
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const launcherPid = child.pid!;
  const messages: unknown[] = [];
  let stdout = "";
  let stderrBytes = 0;
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 64 * 1_024) child.kill();
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      messages.push(JSON.parse(line));
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Contained probe exceeded its fixed test deadline."));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, messages, stderrBytes, launcherPid };
}

function messageOfType(messages: unknown[], type: string): Record<string, unknown> | undefined {
  return messages.find(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null &&
      "type" in message && message.type === type,
  );
}

describe.runIf(isWindows)("real Windows worker containment", () => {
  it("attests the actual restricted token and Job before the first worker instruction", async () => {
    const run = await runProbe("probe-attestation");
    expect(run.code, JSON.stringify({ messages: run.messages, stderrBytes: run.stderrBytes })).toBe(0);
    expect(run.stderrBytes).toBe(0);
    expect(run.messages.map((message) => (message as { type?: string }).type)).toEqual([
      "containment-ready",
      "probe-entry",
    ]);
    const parsed = containmentReadySchema.parse(run.messages[0]);
    expect(parsed.attestation).toMatchObject({
      tokenRestricted: true,
      dangerousPrivilegesDisabled: true,
      privilegedGroupsDisabledOrDenyOnly: true,
      restrictingSidPolicy: "source-user-and-enabled-groups",
      integrity: "medium",
      jobAssigned: true,
      killOnClose: true,
      activeProcessLimit: CONTAINMENT_ACTIVE_PROCESS_LIMIT,
      processMemoryLimitBytes: CONTAINMENT_PROCESS_MEMORY_LIMIT_BYTES,
      jobMemoryLimitBytes: CONTAINMENT_JOB_MEMORY_LIMIT_BYTES,
      cpuRatePercent: CONTAINMENT_CPU_RATE_PERCENT,
      breakawayAllowed: false,
    });
    expect(["nested", "none"]).toContain(parsed.attestation.hostJob);
    expect(() => process.kill(run.launcherPid, 0)).toThrow();
  });

  it("uses the Job hard process limit to deny a second process", async () => {
    const run = await runProbe("probe-child");
    expect(run.code, JSON.stringify({ messages: run.messages, stderrBytes: run.stderrBytes })).toBe(0);
    expect(messageOfType(run.messages, "probe-child-result")).toMatchObject({ denied: true });
    expect(messageOfType(run.messages, "containment-probe-result"), JSON.stringify(run.messages))
      .toMatchObject({
      category: "process-limit",
      quotaRejection: true,
      candidateTerminationConfirmed: true,
      postAttemptActiveProcesses: 0,
      postAttemptLiveJobMembers: 0,
      noEscapedLiveChild: true,
    });
    expect(messageOfType(run.messages, "containment-fault")).toBeUndefined();
    expect(run.stderrBytes).toBe(0);
  });

  it("terminates the bounded allocation probe at the Job memory limit", async () => {
    const run = await runProbe("probe-memory");
    expect(run.code).toBe(48);
    expect(messageOfType(run.messages, "probe-entry")).toBeDefined();
    expect(messageOfType(run.messages, "probe-memory-result")).toBeUndefined();
    expect(messageOfType(run.messages, "containment-fault"), JSON.stringify(run.messages)).toMatchObject({
      category: "memory-limit",
    });
    expect(run.stderrBytes).toBe(0);
    expect(() => process.kill(run.launcherPid, 0)).toThrow();
  });

  it("queries a CPU hard cap and completes only a bounded CPU probe", async () => {
    const run = await runProbe("probe-cpu");
    expect(run.code).toBe(0);
    expect(containmentReadySchema.parse(run.messages[0]).attestation.cpuRatePercent)
      .toBe(CONTAINMENT_CPU_RATE_PERCENT);
    expect(messageOfType(run.messages, "probe-cpu-result")).toMatchObject({ completed: true });
  });

  it("breaks the exact inherited liveness pipe on real parent exit and leaves no launcher", async () => {
    const parent = fork(launcherParentPath, [], {
      env: {},
      execPath: process.execPath,
      silent: true,
    });
    const launcherPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Parent fixture did not attest in time.")), 3_000);
      parent.once("message", (message: unknown) => {
        if (
          typeof message !== "object" || message === null ||
          !("type" in message) || message.type !== "launcher-ready" ||
          !("launcherPid" in message) || typeof message.launcherPid !== "number"
        ) return;
        clearTimeout(timer);
        resolve(message.launcherPid);
      });
      parent.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const parentExit = await new Promise<number | null>((resolve) => parent.once("exit", resolve));
    expect(parentExit).toBe(0);
    let launcherAlive = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(launcherPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        launcherAlive = false;
        break;
      }
    }
    expect(launcherAlive).toBe(false);
  });

  it("uses the exact worker handle to confirm termination after parent-liveness loss", async () => {
    const testSpec = fixedWorkerLaunchSpec({
      testOnly: { faultMode: "hang", containmentFaultStage: "none" },
    });
    const child = spawn(testSpec.executable, [
      process.execPath,
      probeWorkerPath,
      "probe-parent-liveness",
      "none",
    ], {
      cwd: dirname(probeWorkerPath),
      env: {},
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stdoutMessages: unknown[] = [];
    const stderrMessages: unknown[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Liveness probe did not enter.")), 3_000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        for (;;) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          const message = JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>;
          stdout = stdout.slice(newline + 1);
          stdoutMessages.push(message);
          if (message.type !== "probe-parent-ready") continue;
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      for (;;) {
        const newline = stderr.indexOf("\n");
        if (newline < 0) break;
        stderrMessages.push(JSON.parse(stderr.slice(0, newline)));
        stderr = stderr.slice(newline + 1);
      }
    });
    await ready;
    child.stdio[3]!.destroy();
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(48);
    expect(messageOfType(stdoutMessages, "probe-parent-ready")).toBeDefined();
    expect(messageOfType(stderrMessages, "containment-probe-result")).toMatchObject({
      category: "parent-liveness",
      workerTerminationConfirmed: true,
    });
  });

  it("fails before worker entry when the inherited parent-liveness pipe is closed", async () => {
    const testSpec = fixedWorkerLaunchSpec({
      testOnly: { faultMode: "hang", containmentFaultStage: "none" },
    });
    const child = spawn(testSpec.executable, [
      process.execPath,
      probeWorkerPath,
      "probe-attestation",
      "none",
    ], {
      cwd: dirname(probeWorkerPath),
      env: {},
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    child.stdio[3]!.destroy();
    const messages: unknown[] = [];
    let stdout = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        messages.push(JSON.parse(stdout.slice(0, newline)));
        stdout = stdout.slice(newline + 1);
      }
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(41);
    expect(messageOfType(messages, "probe-entry")).toBeUndefined();
    expect(messageOfType(messages, "containment-ready")).toBeUndefined();
  });

  it.each([
    ["job", 42],
    ["token", 43],
    ["create", 44],
    ["assign", 45],
    ["attestation", 46],
    ["resume", 47],
  ] as const)("fails closed at the %s stage before worker entry", async (faultStage, exitCode) => {
    const run = await runProbe("probe-attestation", faultStage);
    expect(run.code).toBe(exitCode);
    expect(messageOfType(run.messages, "probe-entry")).toBeUndefined();
    expect(run.stderrBytes).toBe(0);
    expect(() => process.kill(run.launcherPid, 0)).toThrow();
  });

  it.each([
    "job",
    "token",
    "create",
    "assign",
    "attestation",
    "resume",
  ] as const)("maps %s setup failure to the fixed containment category", async (faultStage) => {
    const adapter = new ProcessMockAdapter({
      testOnly: { faultMode: "hang", containmentFaultStage: faultStage },
    });
    try {
      await expect(adapter.start()).rejects.toMatchObject({
        category: "containment",
      });
    } finally {
      await adapter.close();
    }
  });

  it("rejects non-closed-world product argv without starting any worker", async () => {
    const spec = fixedWorkerLaunchSpec();
    const child = spawn(spec.executable, [...spec.argv, "probe-child"], {
      cwd: spec.cwd,
      env: { HOSTILE_OVERRIDE: "ignored" },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout!.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; });
    child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect({ code, stdoutBytes, stderrBytes }).toEqual({ code: 40, stdoutBytes: 0, stderrBytes: 0 });
  });
});

describe("platform containment gate", () => {
  it.runIf(!isWindows)("fails closed without an unrestricted non-Windows fallback", async () => {
    const adapter = new ProcessMockAdapter();
    await expect(adapter.start()).rejects.toMatchObject({
      category: "containment",
    });
    await adapter.close();
  });
});
