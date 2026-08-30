import { spawn } from "node:child_process";
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  GameBridge,
  MemoryAuditSink,
  MockGameAdapter,
  ProcessMockAdapter,
  SafetyLatch,
  SessionManager,
  deriveSessionOwnerKey,
  type BridgeResponse,
  type RequestEnvelope,
  callLocalOperator,
  operatorDescriptorSchema,
  operatorResponseSchema,
  type OperatorResponse,
} from "../src/index.js";
import {
  GAME_BRIDGE_TOOL_NAME,
  HandlerConcurrencyGate,
  STDIO_MAX_BUFFER_BYTES,
} from "../src/mcp/server.js";
import {
  OPERATOR_MAX_FRAME_BYTES,
  OPERATOR_PIPE_PREFIX,
  OPERATOR_PROTOCOL_VERSION,
} from "../src/operator/protocol.js";
import {
  LocalOperatorServer,
  operatorDescriptorPath,
  operatorRuntimeDirectory,
  startLocalOperatorServer,
} from "../src/operator/server.js";

const servers: LocalOperatorServer[] = [];
const adapters: ProcessMockAdapter[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.close()));
});

function bridgeFixture() {
  const registry = new AdapterRegistry();
  registry.register(new MockGameAdapter());
  const audit = new MemoryAuditSink();
  const bridge = new GameBridge({ registry, auditSink: audit });
  return { audit, bridge, control: bridge.createLocalControlPlane() };
}

async function startFixture(options: ConstructorParameters<typeof LocalOperatorServer>[1] = {}) {
  const fixture = bridgeFixture();
  const server = await startLocalOperatorServer(fixture.control, options);
  servers.push(server);
  return { ...fixture, server };
}

async function descriptor() {
  const bytes = await readFile(operatorDescriptorPath());
  const parsed = operatorDescriptorSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  bytes.fill(0);
  if (!parsed.success) throw new Error("fixture descriptor was invalid");
  return parsed.data;
}

async function rawCall(
  chunks: Buffer[],
  options: { pauseMs?: number } = {},
): Promise<OperatorResponse> {
  const current = await descriptor();
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(current.endpoint);
    let output = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw operator fixture timed out"));
    }, 3_000);
    socket.on("connect", () => {
      chunks.forEach((chunk, index) => {
        setTimeout(() => socket.write(chunk), index * (options.pauseMs ?? 0));
      });
    });
    socket.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      clearTimeout(timer);
      const parsed = operatorResponseSchema.safeParse(
        JSON.parse(output.subarray(0, newline).toString("utf8")),
      );
      output.fill(0);
      socket.destroy();
      if (!parsed.success) reject(new Error("fixture response was invalid"));
      else resolvePromise(parsed.data);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function operatorRequest(command: Record<string, unknown>, token: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({ version: OPERATOR_PROTOCOL_VERSION, token, ...command })}\n`,
    "utf8",
  );
}

function expectOperatorError(response: OperatorResponse, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe(code);
}

function request(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  options: { sessionId?: string; mode?: "dry-run" | "commit" } = {},
): RequestEnvelope {
  return {
    protocolVersion: "1.0",
    requestId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    action,
    params,
    mode: options.mode ?? "commit",
  };
}

async function callBridge(client: Client, envelope: RequestEnvelope): Promise<BridgeResponse> {
  const result = await client.callTool({
    name: GAME_BRIDGE_TOOL_NAME,
    arguments: envelope as unknown as Record<string, unknown>,
  });
  return result.structuredContent as BridgeResponse;
}

function expectBridgeError(response: BridgeResponse, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe(code);
}

async function runCli(args: string[]) {
  const entrypoint = resolve(process.cwd(), "dist", "src", "operator", "cli.js");
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? -1));
  });
  return { exitCode, stderr, stdout };
}

async function waitUntilMissing(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(path);
    } catch {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return false;
}

describe("local operator control plane", () => {
  it("shares safety state, enforces stop generations, and writes bounded audit events", async () => {
    const { audit } = await startFixture();
    const initial = await callLocalOperator({ command: "status" });
    expect(initial).toMatchObject({
      ok: true,
      command: "status",
      status: { stopped: false, stopGeneration: 0 },
    });
    expect(audit.events).toHaveLength(0);

    const stopped = await callLocalOperator({ command: "stop" });
    expect(stopped).toMatchObject({
      ok: true,
      command: "stop",
      alreadyStopped: false,
      status: { stopped: true, stopGeneration: 1 },
    });
    const repeated = await callLocalOperator({ command: "stop" });
    expect(repeated).toMatchObject({
      ok: true,
      command: "stop",
      alreadyStopped: true,
      status: { stopGeneration: 1 },
    });
    expectOperatorError(
      await callLocalOperator({ command: "resume", generation: 2 }),
      "GENERATION_MISMATCH",
    );
    expect(await callLocalOperator({ command: "resume", generation: 1 })).toMatchObject({
      ok: true,
      command: "resume",
      status: { stopped: false, stopGeneration: 1 },
    });
    expectOperatorError(
      await callLocalOperator({ command: "resume", generation: 1 }),
      "NOT_STOPPED",
    );
    expect(await callLocalOperator({ command: "stop" })).toMatchObject({
      ok: true,
      status: { stopGeneration: 2 },
    });
    expectOperatorError(
      await callLocalOperator({ command: "resume", generation: 1 }),
      "GENERATION_MISMATCH",
    );
    const concurrent = await Promise.all([
      callLocalOperator({ command: "resume", generation: 2 }),
      callLocalOperator({ command: "resume", generation: 2 }),
    ]);
    expect(concurrent.filter((response) => response.ok)).toHaveLength(1);
    const deniedConcurrent = concurrent.find((response) => !response.ok);
    expect(deniedConcurrent).toBeDefined();
    if (deniedConcurrent !== undefined) {
      expectOperatorError(deniedConcurrent, "NOT_STOPPED");
    }

    expect(audit.events.map((event) => [event.action, event.decision])).toEqual([
      ["safety.stop.local", "allow"],
      ["safety.stop.local", "allow"],
      ["safety.resume.local", "deny"],
      ["safety.resume.local", "allow"],
      ["safety.resume.local", "deny"],
      ["safety.stop.local", "allow"],
      ["safety.resume.local", "deny"],
      ["safety.resume.local", "allow"],
      ["safety.resume.local", "deny"],
    ]);
    const serialized = JSON.stringify(audit.events);
    const current = await descriptor();
    expect(serialized).not.toContain(current.token);
    expect(serialized).not.toContain(current.endpoint);
    expect(serialized).not.toContain(homedir());
  });

  it("fail-closes authentication, malformed, unknown, oversized, split, and coalesced frames", async () => {
    await startFixture();
    const current = await descriptor();
    expectOperatorError(
      await rawCall([operatorRequest({ command: "status" }, "A".repeat(43))]),
      "AUTHENTICATION_FAILED",
    );
    expectOperatorError(
      await rawCall([
        operatorRequest(
          { command: "unknown", injected: "Bearer-attacker-payload-123" },
          current.token,
        ),
      ]),
      "INVALID_REQUEST",
    );
    expectOperatorError(await rawCall([Buffer.from("{bad-json}\n")]), "INVALID_REQUEST");
    expectOperatorError(
      await rawCall([Buffer.from(`${"x".repeat(OPERATOR_MAX_FRAME_BYTES + 1)}\n`)]),
      "INVALID_REQUEST",
    );
    expectOperatorError(
      await rawCall([operatorRequest({ command: "resume" }, current.token)]),
      "INVALID_REQUEST",
    );

    const split = operatorRequest({ command: "status" }, current.token);
    const splitAt = Math.floor(split.byteLength / 2);
    expect(
      await rawCall([split.subarray(0, splitAt), split.subarray(splitAt)], { pauseMs: 10 }),
    ).toMatchObject({ ok: true, command: "status" });

    const statusFrame = operatorRequest({ command: "status" }, current.token);
    expectOperatorError(
      await rawCall([Buffer.concat([statusFrame, statusFrame])]),
      "INVALID_REQUEST",
    );
    expect(await callLocalOperator({ command: "status" })).toMatchObject({
      ok: true,
      status: { stopped: false, stopGeneration: 0 },
    });
  });

  it("bounds slow connections and releases capacity after timeout and disconnect", async () => {
    await startFixture({ maxConnections: 2, readTimeoutMs: 80, closeTimeoutMs: 80 });
    const current = await descriptor();
    const sockets = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<Socket>((resolvePromise, reject) => {
            const socket = createConnection(current.endpoint);
            socket.once("connect", () => resolvePromise(socket));
            socket.once("error", reject);
          }),
      ),
    );
    const capacity = await rawCall([operatorRequest({ command: "status" }, current.token)]);
    expectOperatorError(capacity, "CAPACITY");
    sockets[0]!.destroy();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 160));
    expect(await callLocalOperator({ command: "status" })).toMatchObject({
      ok: true,
      command: "status",
    });
    sockets[1]!.destroy();
  });

  it("keeps stop independent of full sessions, handler permits, adapter pending work, and writes", async () => {
    const adapter = new ProcessMockAdapter({
      callTimeoutMs: 5_000,
      maxPendingCalls: 1,
      testOnly: { faultMode: "hang" },
    });
    adapters.push(adapter);
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const sessions = new SessionManager({ maxSessions: 1, idGenerator: () => "only-session" });
    const safetyLatch = new SafetyLatch({ maxInFlightWrites: 1 });
    const bridge = new GameBridge({ registry, sessions, safetyLatch });
    const server = await startLocalOperatorServer(bridge.createLocalControlPlane());
    servers.push(server);
    const gate = new HandlerConcurrencyGate(1);
    const gatePermit = gate.tryAcquire();
    const writePermit = safetyLatch.beginWrite();
    expect(gatePermit).toBeDefined();
    expect(writePermit.allowed).toBe(true);
    const ownerKey = deriveSessionOwnerKey({ transport: "local" });
    sessions.open(ownerKey, "mock-world", ["game.observe"]);
    expect(() => sessions.open(ownerKey, "mock-world", ["game.observe"])).toThrow();
    const pendingAdapter = adapter.observe().catch((error: unknown) => error);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    await expect(adapter.observe()).rejects.toMatchObject({ category: "capacity" });

    const stopped = await callLocalOperator({ command: "stop" });
    expect(stopped).toMatchObject({
      ok: true,
      status: { stopped: true, inFlightWrites: 1, stopGeneration: 1 },
    });
    expectOperatorError(
      await callLocalOperator({ command: "resume", generation: 1 }),
      "WRITES_IN_FLIGHT",
    );
    if (writePermit.allowed) writePermit.release();
    expect(await callLocalOperator({ command: "status" })).toMatchObject({
      ok: true,
      status: { stopped: true, inFlightWrites: 0, stopGeneration: 1 },
    });
    expect(await callLocalOperator({ command: "resume", generation: 1 })).toMatchObject({
      ok: true,
      status: { stopped: false },
    });

    gatePermit?.release();
    await adapter.close();
    await pendingAdapter;
    expect(gate.inFlight).toBe(0);
    expect(adapter.pendingCalls).toBe(0);
  });

  it("fails product startup closed on a stale descriptor and preserves that foreign file", async () => {
    const directory = operatorRuntimeDirectory();
    let directoryCreated = false;
    try {
      await mkdir(directory);
      directoryCreated = true;
    } catch {
      // A clean, pre-existing application directory is allowed.
    }
    const marker = "foreign-stale-descriptor";
    await writeFile(operatorDescriptorPath(), marker, { flag: "wx" });
    const entrypoint = resolve(process.cwd(), "dist", "src", "mcp", "stdio-server.js");
    const child = spawn(process.execPath, [entrypoint], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(code ?? -1));
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Local operator control startup failed.\n");
    expect(await readFile(operatorDescriptorPath(), "utf8")).toBe(marker);
    await unlink(operatorDescriptorPath());
    if (directoryCreated) await rmdir(directory);
  });

  it("fails closed on a named-pipe collision without publishing a descriptor", async () => {
    const endpoint = `${OPERATOR_PIPE_PREFIX}00000000000000000000000000000000`;
    const blocker = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      blocker.once("error", reject);
      blocker.listen(endpoint, resolvePromise);
    });
    const fixture = bridgeFixture();
    try {
      await expect(
        startLocalOperatorServer(fixture.control, {
          listenTimeoutMs: 200,
          testOnly: { faultMode: "fixed-endpoint" },
        }),
      ).rejects.toMatchObject({ category: "listener" });
      await expect(stat(operatorDescriptorPath())).rejects.toBeDefined();
    } finally {
      await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()));
    }
  });

  it("never deletes a descriptor replacement that this launch did not create", async () => {
    const directory = operatorRuntimeDirectory();
    let directoryExisted = true;
    try {
      await stat(directory);
    } catch {
      directoryExisted = false;
    }
    const { server } = await startFixture();
    const replacement = "foreign-replacement-after-start";
    await unlink(operatorDescriptorPath());
    await writeFile(operatorDescriptorPath(), replacement, { flag: "wx" });
    await server.close();
    expect(await readFile(operatorDescriptorPath(), "utf8")).toBe(replacement);
    await unlink(operatorDescriptorPath());
    if (!directoryExisted) await rmdir(directory);
  });

  it("uses the same built stdio runtime for MCP commits and operator CLI control", async () => {
    const entrypoint = resolve(process.cwd(), "dist", "src", "mcp", "stdio-server.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: process.cwd(),
      stderr: "pipe",
      maxBufferSize: STDIO_MAX_BUFFER_BYTES,
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "operator-e2e", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        GAME_BRIDGE_TOOL_NAME,
      ]);
      expect(await runCli(["status"])).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "STATUS stopped=false inFlightWrites=0 maxInFlightWrites=4 generation=0\n",
      });

      const opened = await callBridge(
        client,
        request("operator-open", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe", "game.act.move", "safety.stop"],
        }),
      );
      expect(opened.ok).toBe(true);
      const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
      const stopCli = await runCli(["stop"]);
      expect(stopCli).toEqual({
        exitCode: 0,
        stderr: "",
        stdout:
          "STOPPED stopped=true inFlightWrites=0 maxInFlightWrites=4 generation=1 alreadyStopped=false\n",
      });
      expectBridgeError(
        await callBridge(
          client,
          request(
            "operator-blocked-commit",
            "game.act",
            {
              adapterId: "mock-world",
              gameAction: "move",
              input: { dx: 1, dy: 0, dz: 0 },
            },
            { sessionId },
          ),
        ),
        "SAFETY_STOPPED",
      );
      expect(
        await callBridge(
          client,
          request(
            "operator-observe",
            "game.observe",
            { adapterId: "mock-world" },
            { sessionId },
          ),
        ),
      ).toMatchObject({ ok: true });
      expect(
        await callBridge(
          client,
          request(
            "operator-dry-run",
            "game.act",
            {
              adapterId: "mock-world",
              gameAction: "move",
              input: { dx: 1, dy: 0, dz: 0 },
            },
            { sessionId, mode: "dry-run" },
          ),
        ),
      ).toMatchObject({ ok: true });
      const second = await callBridge(
        client,
        request("operator-open-close", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe"],
        }),
      );
      const secondSessionId = (second as { result: { sessionId: string } }).result.sessionId;
      expect(
        await callBridge(
          client,
          request("operator-close", "session.close", {}, { sessionId: secondSessionId }),
        ),
      ).toMatchObject({ ok: true });

      expect(await runCli(["resume", "--generation", "1"])).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "RESUMED stopped=false inFlightWrites=0 maxInFlightWrites=4 generation=1\n",
      });
      expect(
        await callBridge(
          client,
          request(
            "operator-commit-after-resume",
            "game.act",
            {
              adapterId: "mock-world",
              gameAction: "move",
              input: { dx: 1, dy: 0, dz: 0 },
            },
            { sessionId },
          ),
        ),
      ).toMatchObject({ ok: true });
      expect(
        await callBridge(
          client,
          request("operator-mcp-stop", "safety.stop", {}, { sessionId }),
        ),
      ).toMatchObject({ ok: true });
      expect(await runCli(["status"])).toMatchObject({
        exitCode: 0,
        stderr: "",
        stdout: expect.stringContaining("stopped=true"),
      });
      expectBridgeError(
        await callBridge(
          client,
          request("operator-mcp-status", "safety.status", {}, { sessionId }),
        ),
        "UNKNOWN_ACTION",
      );
      expectBridgeError(
        await callBridge(
          client,
          request("operator-mcp-resume", "safety.resume", {}, { sessionId }),
        ),
        "UNKNOWN_ACTION",
      );
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
    expect(stderr).toBe("");
    expect(await waitUntilMissing(operatorDescriptorPath())).toBe(true);
    expect(await runCli(["status"])).toEqual({
      exitCode: 3,
      stderr: "OPERATOR_ERROR code=NOT_RUNNING\n",
      stdout: "",
    });
  });
});
