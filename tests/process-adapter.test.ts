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
  GAME_BRIDGE_TOOL_NAME,
  createGameBridgeMcpServer,
  fixedWorkerLaunchSpec,
  type BridgeResponse,
  type RequestEnvelope,
} from "../src/index.js";

function fixtureAdapter(
  mode: AdapterWorkerFaultMode,
  options: { callTimeoutMs?: number; handshakeTimeoutMs?: number; maxPendingCalls?: number } = {},
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

describe("isolated mock adapter runner", () => {
  it("uses a fixed built worker identity and shuts down without an orphan", async () => {
    const adapter = new ProcessMockAdapter();
    await adapter.start();
    const pid = adapter.workerPid!;
    expect(pid).toBeGreaterThan(0);
    expect(await adapter.observe()).toMatchObject({ player: { x: 0, y: 1, z: 0 } });
    await adapter.close();
    expect(adapter.pendingCalls).toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("keeps executable, argv, cwd, and minimal environment outside request control", async () => {
    const sentinelName = "ADAPTER_PASSWORD_SENTINEL";
    process.env[sentinelName] = "Bearer-parent-secret";
    try {
      const spec = fixedWorkerLaunchSpec();
      expect(spec.executable).toBe(process.execPath);
      expect(spec.argv).toHaveLength(1);
      expect(spec.argv[0]).toMatch(/dist[\\/]src[\\/]adapters[\\/]mock[\\/]mock-worker\.js$/);
      expect(spec.shell).toBe(false);
      expect(spec.env).toEqual({ XIAOQIE_ADAPTER_WORKER: "mock-v1" });
      expect(JSON.stringify(spec)).not.toContain(process.env[sentinelName]);

      const adapter = fixtureAdapter("env-check");
      try {
        const result = await adapter.observe() as { environmentKeys: string[] };
        expect(result.environmentKeys).toContain("XIAOQIE_ADAPTER_WORKER");
        expect(result.environmentKeys).toContain("XIAOQIE_TEST_MODE");
        expect(result.environmentKeys).not.toContain(sentinelName);
        expect(JSON.stringify(result)).not.toContain("Bearer-parent-secret");
      } finally {
        await adapter.close();
      }
    } finally {
      delete process.env[sentinelName];
    }
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

  it.each(["malformed", "unknown-field", "unknown-type", "oversized", "wrong-id"] as const)(
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
      expect(await adapter.observe()).toEqual({ fixture: true });
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

  it("bounds handshake, call time, pending capacity, and close with pending work", async () => {
    const noHandshake = fixtureAdapter("no-handshake", { handshakeTimeoutMs: 20 });
    expect(await category(noHandshake.start())).toBe("handshake");
    await noHandshake.close();

    const timeout = fixtureAdapter("hang", { callTimeoutMs: 20 });
    expect(await category(timeout.observe())).toBe("timeout");
    expect(timeout.pendingCalls).toBe(0);
    await timeout.close();

    const bounded = fixtureAdapter("hang", { callTimeoutMs: 5_000, maxPendingCalls: 1 });
    const pending = bounded.observe();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await category(bounded.observe())).toBe("capacity");
    await bounded.close();
    expect(await category(pending)).toBe("closed");
    expect(bounded.pendingCalls).toBe(0);
  });

  it("maps hostile worker output to fixed bridge response and sanitized audit", async () => {
    const adapter = fixtureAdapter("malformed");
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
      expect(serialized).not.toContain("Bearer-worker-secret");
      expect(serialized).not.toContain("private");
      expect(serialized).not.toContain("stack");
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
