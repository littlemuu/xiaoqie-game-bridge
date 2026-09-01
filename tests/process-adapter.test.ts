import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  AdapterRunnerError,
  type AdapterWorkerFaultMode,
  GameBridge,
  MemoryAuditSink,
  ProcessMockAdapter,
  SessionManager,
  ADAPTER_IPC_MAX_FRAME_BYTES,
  ADAPTER_IPC_VERSION,
  GAME_BRIDGE_TOOL_NAME,
  adapterParentMessageSchema,
  createGameBridgeMcpServer,
  encodeAdapterFrame,
  fixedWorkerLaunchSpec,
  type BridgeResponse,
  type RequestEnvelope,
} from "../src/index.js";

function fixtureAdapter(
  mode: AdapterWorkerFaultMode,
  options: {
    callTimeoutMs?: number;
    closeTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    maxPendingCalls?: number;
  } = {},
): ProcessMockAdapter {
  return new ProcessMockAdapter({
    ...options,
    testOnly: {
      faultMode: mode,
    },
  });
}

async function category(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AdapterRunnerError ? error.category : "unexpected";
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for worker test event.")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function request(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  sessionId?: string,
): RequestEnvelope {
  return {
    protocolVersion: "1.0",
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    action,
    params,
    mode: "commit",
  };
}

function expectError(response: BridgeResponse, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe(code);
}

describe.runIf(process.platform === "win32")("isolated mock adapter runner", () => {
  it("uses a fixed built worker identity and exposes only attested health", async () => {
    const adapter = new ProcessMockAdapter();
    await adapter.start();
    expect(adapter.containmentAttestation).toMatchObject({ jobAssigned: true });
    expect(await adapter.observe()).toMatchObject({ player: { x: 0, y: 1, z: 0 } });
    await adapter.close();
    expect(adapter.pendingCalls).toBe(0);
  });

  it("parses legal frames across arbitrary split and coalesced input chunks", async () => {
    const spec = fixedWorkerLaunchSpec();
    const child = spawn(spec.executable, spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout! });
    let readyResolve: (() => void) | undefined;
    let resultsResolve: (() => void) | undefined;
    let expectedResults = Number.POSITIVE_INFINITY;
    const resultIds = new Set<string>();
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const results = new Promise<void>((resolve) => {
      resultsResolve = resolve;
    });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as { type?: string; callId?: string };
      if (message.type === "ready") readyResolve?.();
      if (message.type === "result" && message.callId !== undefined) {
        resultIds.add(message.callId);
        if (resultIds.size === expectedResults) resultsResolve?.();
      }
    });
    let exited = false;
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        exited = true;
        resolve(code);
      });
    });

    try {
      await within(ready, 2_000);
      const frames: Buffer[] = [];
      let totalBytes = 0;
      for (let index = 1; totalBytes <= ADAPTER_IPC_MAX_FRAME_BYTES; index += 1) {
        const frame = encodeAdapterFrame({
          version: ADAPTER_IPC_VERSION,
          type: "call",
          callId: `call-${index}`,
          operation: "observe",
        });
        frames.push(frame);
        totalBytes += frame.byteLength;
      }
      expectedResults = frames.length;
      const coalesced = Buffer.concat(frames);
      expect(coalesced.byteLength).toBeGreaterThan(ADAPTER_IPC_MAX_FRAME_BYTES);
      child.stdin!.write(coalesced.subarray(0, 1));
      await new Promise((resolve) => setImmediate(resolve));
      child.stdin!.write(coalesced.subarray(1));
      await within(results, 5_000);
      expect(resultIds.size).toBe(expectedResults);

      child.stdin!.write(encodeAdapterFrame({
        version: ADAPTER_IPC_VERSION,
        type: "shutdown",
      }));
      expect(await within(exit, 2_000)).toBe(0);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      lines.close();
      if (!exited) child.kill();
    }
  });

  it("keeps executable, argv, cwd, and minimal environment outside request control", async () => {
    const sentinelName = "ADAPTER_PASSWORD_SENTINEL";
    process.env[sentinelName] = "Bearer-parent-secret";
    try {
      const spec = fixedWorkerLaunchSpec();
      expect(spec.executable).toMatch(/dist[\\/]native[\\/]xiaoqie-worker-launcher\.exe$/);
      expect(spec.argv).toHaveLength(2);
      expect(spec.argv[0]).toBe(process.execPath);
      expect(spec.argv[1]).toMatch(/dist[\\/]src[\\/]adapters[\\/]mock[\\/]mock-worker\.js$/);
      expect(spec.shell).toBe(false);
      expect(spec.env).toEqual({});
      expect(JSON.stringify(spec)).not.toContain(process.env[sentinelName]);

      const adapter = fixtureAdapter("env-check");
      try {
        const result = await adapter.observe();
        expect(result).toMatchObject({ player: { x: 0, y: 1, z: 0 } });
        expect(JSON.stringify(result)).not.toContain("Bearer-parent-secret");
      } finally {
        await adapter.close();
      }
    } finally {
      delete process.env[sentinelName];
    }
  });

  it("rejects action-mismatched and non-strict worker call inputs", () => {
    const base = {
      version: ADAPTER_IPC_VERSION,
      type: "call",
      callId: "call-1",
      operation: "execute",
      action: "move",
      mode: "commit",
    } as const;
    expect(adapterParentMessageSchema.safeParse({
      ...base,
      input: { dx: 1, dy: 0, dz: 0 },
    }).success).toBe(true);
    expect(adapterParentMessageSchema.safeParse({
      ...base,
      input: { x: 1, y: 1, z: 0, blockType: "stone" },
    }).success).toBe(false);
    expect(adapterParentMessageSchema.safeParse({
      ...base,
      input: { dx: 1, dy: 0, dz: 0, authorization: "Bearer-input-secret" },
    }).success).toBe(false);
  });

  it("preserves dry-run, one-effect idempotency, safety stop, observe, and close", async () => {
    const adapter = new ProcessMockAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const bridge = new GameBridge({ registry });
    const local = { transport: "local" } as const;
    try {
      const opened = await bridge.handle(
        request("open", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe", "game.act.move", "safety.stop"],
        }),
        local,
      );
      expect(opened.ok).toBe(true);
      const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
      const move = {
        adapterId: "mock-world",
        gameAction: "move",
        input: { dx: 1, dy: 0, dz: 0 },
      };
      const preview = await bridge.handle(
        { ...request("preview", "game.act", move, sessionId), mode: "dry-run" },
        local,
      );
      expect(preview.ok && preview.result).toMatchObject({ applied: false });
      const commit = request("same", "game.act", move, sessionId);
      const [first, duplicate] = await Promise.all([
        bridge.handle(commit, local),
        bridge.handle(commit, local),
      ]);
      expect(first.ok).toBe(true);
      expect(duplicate).toEqual(first);
      const observed = await bridge.handle(
        request("observe", "game.observe", { adapterId: "mock-world" }, sessionId),
        local,
      );
      expect(observed.ok && observed.result).toMatchObject({ player: { x: 1 } });
      expect((await bridge.handle(request("stop", "safety.stop", {}, sessionId), local)).ok).toBe(true);
      expectError(await bridge.handle(request("blocked", "game.act", move, sessionId), local), "SAFETY_STOPPED");
      expect((await bridge.handle(request("close", "session.close", {}, sessionId), local)).ok).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it.each([
    "malformed",
    "unknown-field",
    "unknown-type",
    "oversized",
    "wrong-id",
    "wrong-result",
    "credential-result",
  ] as const)(
    "fail-closes %s worker output and releases pending capacity",
    async (mode) => {
      const adapter = fixtureAdapter(mode);
      try {
        expect(await category(adapter.observe())).toBe("protocol");
        expect(adapter.pendingCalls).toBe(0);
      } finally {
        await adapter.close();
      }
    },
  );

  it("rejects duplicate and late call IDs instead of accepting a second result", async () => {
    const adapter = fixtureAdapter("duplicate-id");
    try {
      expect(await adapter.observe()).toEqual({
        player: { x: 0, y: 1, z: 0 },
        nearbyBlocks: [],
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(["protocol", "closed"]).toContain(await category(adapter.observe()));
      expect(adapter.pendingCalls).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it.each(["crash", "eof"] as const)("settles pending work on %s", async (mode) => {
    const adapter = fixtureAdapter(mode);
    try {
      expect(await category(adapter.observe())).toBe("worker-exit");
      expect(adapter.pendingCalls).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it("rejects a mismatched worker identity during handshake", async () => {
    const adapter = fixtureAdapter("bad-handshake");
    expect(await category(adapter.start())).toBe("handshake");
    expect(adapter.pendingCalls).toBe(0);
    await adapter.close();
  });

  it("settles startup and waits for worker exit when close wins the handshake race", async () => {
    const adapter = fixtureAdapter("no-handshake", {
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 20,
    });
    const startupCategory = category(adapter.start());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.close();
    expect(await startupCategory).toBe("closed");
  });

  it("waits for actual worker exit after an unacknowledged shutdown timeout", async () => {
    const adapter = fixtureAdapter("hang", { closeTimeoutMs: 20 });
    await adapter.start();
    await adapter.close();
  });

  it.each(["crash", "eof"] as const)(
    "rejects %s during normal close and leaves no live worker",
    async (mode) => {
      const adapter = fixtureAdapter(mode);
      await adapter.start();
      expect(await category(adapter.close())).toBe("worker-exit");
      expect(adapter.pendingCalls).toBe(0);
    },
  );

  it("latches a protocol failure after shutdown acknowledgement", async () => {
    const adapter = fixtureAdapter("ack-invalid");
    await adapter.start();
    expect(await category(adapter.close())).toBe("protocol");
    expect(adapter.pendingCalls).toBe(0);
  });

  it("bounds handshake, call time, pending capacity, and close with pending work", async () => {
    const noHandshake = fixtureAdapter("no-handshake", { handshakeTimeoutMs: 500 });
    expect(await category(noHandshake.start())).toBe("handshake");
    await noHandshake.close();

    const timeout = fixtureAdapter("hang", { callTimeoutMs: 20 });
    expect(await category(timeout.observe())).toBe("timeout");
    expect(timeout.pendingCalls).toBe(0);
    await timeout.close();

    const bounded = fixtureAdapter("hang", { callTimeoutMs: 5_000, maxPendingCalls: 1 });
    const pendingCategory = category(bounded.observe());
    await new Promise((resolve) => setImmediate(resolve));
    expect(await category(bounded.observe())).toBe("capacity");
    await bounded.close();
    expect(await pendingCategory).toBe("closed");
    expect(bounded.pendingCalls).toBe(0);
  });

  it("keeps credential-shaped success output out of bridge responses and audit", async () => {
    const adapter = fixtureAdapter("credential-result");
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const audit = new MemoryAuditSink();
    const sessions = new SessionManager({ idGenerator: () => "fixture-session" });
    const bridge = new GameBridge({ registry, auditSink: audit, sessions });
    const local = { transport: "local" } as const;
    try {
      const opened = await bridge.handle(
        request("open-hostile", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe"],
        }),
        local,
      );
      const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
      const response = await bridge.handle(
        request("observe-hostile", "game.observe", { adapterId: "mock-world" }, sessionId),
        local,
      );
      expectError(response, "INTERNAL_ERROR");
      const serialized = JSON.stringify({ response, audit: audit.events });
      expect(serialized).not.toContain("Bearer-worker-result-secret");
      expect(serialized).not.toContain("authorization");
      expect(serialized).not.toContain("fault-adapter-worker");
    } finally {
      await adapter.close();
    }
  });

  it("settles entered worker calls after client disconnect without claiming rollback", async () => {
    const adapter = fixtureAdapter("hang", { callTimeoutMs: 5_000 });
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const bridge = new GameBridge({ registry });
    const server = createGameBridgeMcpServer({ bridge });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "disconnect-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await adapter.start();
      const opened = await client.callTool({
        name: GAME_BRIDGE_TOOL_NAME,
        arguments: request("disconnect-open", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe"],
        }) as unknown as Record<string, unknown>,
      });
      const sessionId = (opened.structuredContent as { result: { sessionId: string } })
        .result.sessionId;
      const enteredCall = client.callTool({
        name: GAME_BRIDGE_TOOL_NAME,
        arguments: request(
          "disconnect-observe",
          "game.observe",
          { adapterId: "mock-world" },
          sessionId,
        ) as unknown as Record<string, unknown>,
      });
      const settledCall = enteredCall.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      for (let attempt = 0; attempt < 50 && adapter.pendingCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(adapter.pendingCalls).toBe(1);
      await client.close();
      await adapter.close();
      const settled = await settledCall;
      expect(adapter.pendingCalls).toBe(0);
      expect(JSON.stringify(settled)).not.toMatch(/cancelled|canceled|rolled back|rollback/i);
    } finally {
      await Promise.allSettled([client.close(), server.close(), adapter.close()]);
    }
  });
});
