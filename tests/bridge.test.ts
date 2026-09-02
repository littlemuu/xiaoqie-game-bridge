import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  GameBridge,
  MemoryAuditSink,
  MockGameAdapter,
  SessionManager,
  type BridgeResponse,
  type RequestEnvelope,
  responseEnvelopeSchema,
} from "../src/index.js";

interface Harness {
  bridge: GameBridge;
  audit: MemoryAuditSink;
  now: { value: number };
}

function createHarness(twoAdapters = false): Harness {
  const registry = new AdapterRegistry();
  registry.register(new MockGameAdapter());
  if (twoAdapters) {
    registry.register(new MockGameAdapter("other-mock"));
  }
  const audit = new MemoryAuditSink();
  const now = { value: Date.parse("2026-08-29T00:00:00.000Z") };
  const sessions = new SessionManager({
    clock: () => now.value,
    idGenerator: () => "test-session",
  });
  return {
    bridge: new GameBridge({
      registry,
      auditSink: audit,
      sessions,
      clock: () => now.value,
    }),
    audit,
    now,
  };
}

function envelope(
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

async function openSession(
  harness: Harness,
  capabilities: string[],
  options: { ttlMs?: number; adapterId?: string } = {},
): Promise<string> {
  const response = await harness.bridge.handle(
    envelope("open", "session.open", {
      adapterId: options.adapterId ?? "mock-world",
      capabilities,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }),
    { transport: "local" },
  );
  expect(response.ok).toBe(true);
  return (response as { result: { sessionId: string } }).result.sessionId;
}

function expectError(response: BridgeResponse, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe(code);
  }
}

async function observe(harness: Harness, sessionId: string, requestId: string) {
  return harness.bridge.handle(
    envelope(
      requestId,
      "game.observe",
      { adapterId: "mock-world" },
      { sessionId },
    ),
    { transport: "local" },
  );
}

function handleLocal(harness: Harness, request: RequestEnvelope): Promise<BridgeResponse> {
  return harness.bridge.handle(request, { transport: "local" });
}

describe("GameBridge safety contract", () => {
  it("rejects contradictory adapter error codes and operation phases", () => {
    const base = {
      protocolVersion: "1.0",
      requestId: "response-contract",
      action: "game.act",
      mode: "commit",
      ok: false,
    } as const;
    expect(responseEnvelopeSchema.safeParse({
      ...base,
      error: {
        code: "ADAPTER_REJECTED",
        message: "rejected",
        operationPhase: "adapter-rejected",
        adapterError: { code: "TARGET_OCCUPIED" },
      },
    }).success).toBe(true);
    for (const error of [
      {
        code: "ADAPTER_REJECTED",
        message: "missing namespace",
        operationPhase: "adapter-rejected",
      },
      {
        code: "RUNTIME_UNAVAILABLE",
        message: "foreign namespace",
        operationPhase: "pre-dispatch",
        adapterError: { code: "TARGET_OCCUPIED" },
      },
      {
        code: "OUTCOME_UNKNOWN",
        message: "wrong phase",
        operationPhase: "adapter-rejected",
      },
      {
        code: "REVISION_CONFLICT",
        message: "missing phase",
      },
    ]) {
      expect(responseEnvelopeSchema.safeParse({ ...base, error }).success).toBe(false);
    }
  });

  it("rejects an invalid envelope without echoing raw input", async () => {
    const harness = createHarness();
    const response = await harness.bridge.handle({
      protocolVersion: "0.9",
      requestId: "bad",
      action: "bridge.describe",
      params: { password: "do-not-echo" },
      mode: "commit",
      extra: true,
    });

    expectError(response, "INVALID_ENVELOPE");
    expect(responseEnvelopeSchema.safeParse(response).success).toBe(true);
    expect(JSON.stringify(response)).not.toContain("do-not-echo");
  });

  it("default-denies unknown bridge actions and undeclared parameters", async () => {
    const harness = createHarness();
    expectError(
      await harness.bridge.handle(envelope("unknown", "system.shell", {})),
      "UNKNOWN_ACTION",
    );
    expectError(
      await harness.bridge.handle(
        envelope("extra", "bridge.describe", { unexpected: true }),
      ),
      "INVALID_PARAMS",
    );
  });

  it("separates observe and act capabilities", async () => {
    const harness = createHarness();
    const sessionId = await openSession(harness, ["game.observe"]);
    const denied = await handleLocal(harness,
      envelope(
        "move-denied",
        "game.act",
        { adapterId: "mock-world", gameAction: "move", input: { dx: 1, dy: 0, dz: 0 } },
        { sessionId },
      ),
    );
    expectError(denied, "CAPABILITY_DENIED");
    expect((await observe(harness, sessionId, "observe-ok")).ok).toBe(true);
  });

  it("rejects expired and closed sessions", async () => {
    const expiredHarness = createHarness();
    const expiredId = await openSession(expiredHarness, ["game.observe"], { ttlMs: 10 });
    expiredHarness.now.value += 10;
    expectError(await observe(expiredHarness, expiredId, "expired"), "SESSION_EXPIRED");

    const closedHarness = createHarness();
    const closedId = await openSession(closedHarness, ["game.observe"]);
    const close = await handleLocal(closedHarness,
      envelope("close", "session.close", {}, { sessionId: closedId }),
    );
    expect(close.ok).toBe(true);
    expectError(await observe(closedHarness, closedId, "closed"), "SESSION_CLOSED");
    expectError(
      await handleLocal(closedHarness,
        envelope("close", "session.close", {}, { sessionId: closedId }),
      ),
      "SESSION_CLOSED",
    );
  });

  it("does not apply a duplicate request ID twice", async () => {
    const harness = createHarness();
    const sessionId = await openSession(harness, ["game.observe", "game.act.move"]);
    const move = envelope(
      "same-move",
      "game.act",
      {
        adapterId: "mock-world",
        gameAction: "move",
        input: { dx: 1, dy: 0, dz: 0 },
        expectedRevision: 0,
      },
      { sessionId },
    );

    const first = await handleLocal(harness, move);
    const duplicate = await handleLocal(harness, move);
    expect(duplicate).toEqual(first);
    const state = await observe(harness, sessionId, "after-duplicate");
    expect(state.ok && state.result).toMatchObject({ player: { x: 1, y: 1, z: 0 } });
    expect(harness.audit.events.at(-2)?.idempotencyHit).toBe(true);

    expectError(
      await handleLocal(harness, {
        ...move,
        params: {
          adapterId: "mock-world",
          gameAction: "move",
          input: { dx: 0, dy: 0, dz: 1 },
        },
      }),
      "REQUEST_ID_REUSED",
    );
  });

  it("coalesces concurrent duplicate requests before adapter execution", async () => {
    const harness = createHarness();
    const sessionId = await openSession(harness, ["game.observe", "game.act.move"]);
    const move = envelope(
      "concurrent-move",
      "game.act",
      {
        adapterId: "mock-world",
        gameAction: "move",
        input: { dx: 1, dy: 0, dz: 0 },
        expectedRevision: 0,
      },
      { sessionId },
    );

    const [first, duplicate] = await Promise.all([
      handleLocal(harness, move),
      handleLocal(harness, move),
    ]);

    expect(duplicate).toEqual(first);
    const state = await observe(harness, sessionId, "after-concurrent-duplicate");
    expect(state.ok && state.result).toMatchObject({ player: { x: 1, y: 1, z: 0 } });
    expect(harness.audit.events.some((event) => event.idempotencyHit)).toBe(true);
  });

  it("keeps dry-run side-effect free and applies authorized commit", async () => {
    const harness = createHarness();
    const sessionId = await openSession(harness, ["game.observe", "game.act.move"]);
    const dryRun = await handleLocal(harness,
      envelope(
        "preview",
        "game.act",
      {
        adapterId: "mock-world",
        gameAction: "move",
        input: { dx: 1, dy: 0, dz: 0 },
        expectedRevision: 0,
      },
        { sessionId, mode: "dry-run" },
      ),
    );
    expect(dryRun.ok && dryRun.result).toMatchObject({ applied: false });
    expect((await observe(harness, sessionId, "before-commit")).ok).toBe(true);
    const before = await observe(harness, sessionId, "before-commit-2");
    expect(before.ok && before.result).toMatchObject({ player: { x: 0, y: 1, z: 0 } });

    const commit = await handleLocal(harness,
      envelope(
        "commit",
        "game.act",
        {
          adapterId: "mock-world",
          gameAction: "move",
          input: { dx: 1, dy: 0, dz: 0 },
          expectedRevision: 0,
        },
        { sessionId },
      ),
    );
    expect(commit.ok && commit.result).toMatchObject({ applied: true });
    const after = await observe(harness, sessionId, "after-commit");
    expect(after.ok && after.result).toMatchObject({ player: { x: 1, y: 1, z: 0 } });
  });

  it("safety stop blocks writes while preserving observation and close", async () => {
    const harness = createHarness();
    const sessionId = await openSession(harness, [
      "game.observe",
      "game.act.move",
      "safety.stop",
    ]);
    expect(
      (
        await handleLocal(harness,
          envelope("stop", "safety.stop", {}, { sessionId }),
        )
      ).ok,
    ).toBe(true);
    expectError(
      await handleLocal(harness,
        envelope(
          "blocked-move",
          "game.act",
        {
          adapterId: "mock-world",
          gameAction: "move",
          input: { dx: 1, dy: 0, dz: 0 },
          expectedRevision: 0,
        },
          { sessionId },
        ),
      ),
      "SAFETY_STOPPED",
    );
    expect((await observe(harness, sessionId, "observe-stopped")).ok).toBe(true);
    expect(
      (
        await handleLocal(harness,
          envelope("close-stopped", "session.close", {}, { sessionId }),
        )
      ).ok,
    ).toBe(true);
  });

  it("does not expose safety resume as a remote bridge action", async () => {
    const harness = createHarness();
    expectError(
      await harness.bridge.handle(envelope("resume", "safety.resume", {}), {
        transport: "remote",
      }),
      "UNKNOWN_ACTION",
    );
  });

  it("treats omitted and explicit remote caller context as untrusted", async () => {
    const harness = createHarness();
    const open = envelope("context-open", "session.open", {
      adapterId: "mock-world",
      capabilities: ["game.act.move"],
    });

    expectError(await harness.bridge.handle(open), "AUTHORIZATION_DENIED");
    expectError(
      await harness.bridge.handle({ ...open, requestId: "remote-open" }, { transport: "remote" }),
      "AUTHORIZATION_DENIED",
    );
    expect(
      (
        await harness.bridge.handle(
          { ...open, requestId: "explicit-local-open" },
          { transport: "local" },
        )
      ).ok,
    ).toBe(true);
  });

  it("recursively redacts credentials and stores only hashed identifiers", async () => {
    const harness = createHarness();
    const sink = harness.audit;
    sink.write({
      timestamp: "2026-08-29T00:00:00.000Z",
      action: "test",
      mode: "commit",
      decision: "deny",
      safetyStopped: false,
      idempotencyHit: false,
      metadata: {
        token: "top-secret-token",
        nested: { password: "password-value", authorization: "Bearer value" },
        items: [{ clientSecret: "client-secret-value", safe: "visible" }],
      },
    });
    const serialized = JSON.stringify(sink.events.at(-1));
    expect(serialized).not.toContain("top-secret-token");
    expect(serialized).not.toContain("password-value");
    expect(serialized).not.toContain("Bearer value");
    expect(serialized).not.toContain("client-secret-value");
    expect(serialized).toContain("[REDACTED]");

    await harness.bridge.handle(envelope("raw-request-id", "bridge.describe", {}));
    const event = sink.events.at(-1)!;
    expect(event.requestIdTag).not.toBe("raw-request-id");
    expect(JSON.stringify(event)).not.toContain("raw-request-id");
  });

  it("never stores attacker-controlled action or adapter identifiers verbatim", async () => {
    const harness = createHarness();
    const actionSecret = "Bearer-review-secret-123";
    const adapterSecret = "adapter-password-review-secret-456";

    expectError(
      await harness.bridge.handle(envelope("malicious-action", actionSecret, {})),
      "UNKNOWN_ACTION",
    );
    const actionEvent = harness.audit.events.at(-1)!;
    expect(actionEvent.action).toBe("unregistered");
    expect(actionEvent.actionTag).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(actionEvent)).not.toContain(actionSecret);

    expectError(
      await harness.bridge.handle(
        envelope("malicious-adapter", "session.open", {
          adapterId: adapterSecret,
          capabilities: [],
        }),
        { transport: "local" },
      ),
      "ADAPTER_NOT_FOUND",
    );
    const adapterEvent = harness.audit.events.at(-1)!;
    expect(adapterEvent.adapterId).toBeUndefined();
    expect(adapterEvent.adapterIdTag).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(adapterEvent)).not.toContain(adapterSecret);
  });

  it("prevents capabilities from being used with another adapter", async () => {
    const harness = createHarness(true);
    const sessionId = await openSession(harness, ["game.observe", "game.act.move"]);
    const response = await handleLocal(harness,
      envelope(
        "cross-adapter",
        "game.act",
        { adapterId: "other-mock", gameAction: "move", input: { dx: 1, dy: 0, dz: 0 } },
        { sessionId },
      ),
    );
    expectError(response, "ADAPTER_MISMATCH");
  });

  it("rejects invalid action schemas and illegal blocks deterministically", async () => {
    const harness = createHarness();
    const sessionId = await openSession(harness, ["game.act.move", "game.act.place_block"]);
    expectError(
      await handleLocal(harness,
        envelope(
          "unknown-game-action",
          "game.act",
          { adapterId: "mock-world", gameAction: "teleport", input: {} },
          { sessionId },
        ),
      ),
      "ACTION_NOT_ALLOWED",
    );
    expectError(
      await handleLocal(harness,
        envelope(
          "bad-block",
          "game.act",
          {
            adapterId: "mock-world",
            gameAction: "place_block",
            input: { x: 0, y: 1, z: 1, blockType: "diamond" },
          },
          { sessionId },
        ),
      ),
      "INVALID_PARAMS",
    );
  });
});
