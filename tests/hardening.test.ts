import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  AdapterExecutionError,
  AdapterRegistry,
  type AdapterActionDefinition,
  type BridgeMode,
  type BridgeResponse,
  GameBridge,
  type GameAdapter,
  MemoryAuditSink,
  SafetyLatch,
  SessionIdCollisionError,
  SessionManager,
  deriveSessionOwnerKey,
  type RequestEnvelope,
  type RequestContext,
} from "../src/index.js";

const TEST_OWNER = deriveSessionOwnerKey({ transport: "local" });
const DIRECT_TEST_GRANT = {
  scope: { kind: "test-resource" as const, resourceId: "direct-session-test" },
  totalActionBudget: 4,
  perActionBudgets: {},
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const gatedInputSchema = z
  .object({
    behavior: z.enum(["success", "wait", "known-error", "unknown-error"]),
  })
  .strict();
const gatedObservationSchema = z
  .object({
    commitEntries: z.number().int().nonnegative(),
    completedWrites: z.number().int().nonnegative(),
    dryRunCalls: z.number().int().nonnegative(),
  })
  .strict();
const gatedResultSchema = z.union([
  z.object({ applied: z.literal(false), behavior: gatedInputSchema.shape.behavior }).strict(),
  z.object({ applied: z.literal(true), completedWrites: z.number().int().positive() }).strict(),
]);

const gatedGrantProvider = {
  grant(request: {
    adapter: GameAdapter;
    context: RequestContext;
    requestedCapabilities: readonly string[];
    requestedTtlMs?: number;
  }) {
    if (request.context.transport !== "local" || request.adapter.id !== "gated-world") {
      return { allowed: false as const };
    }
    return {
      allowed: true as const,
      capabilities: [...new Set(request.requestedCapabilities)].sort(),
      scope: { kind: "gated-world", resourceId: "gated-world" },
      ttlMs: request.requestedTtlMs ?? 1_000,
      totalActionBudget: 64,
      perActionBudgets: { gated_write: 64 },
    };
  },
};

class GatedAdapter implements GameAdapter {
  readonly id = "gated-world";
  readonly displayName = "Deterministic gated adapter";
  readonly observation = {
    description: "Observe deterministic gated test counters.",
    outputSchema: gatedObservationSchema,
    effectKind: "read" as const,
    concurrency: { kind: "parallel" as const },
    requiredCapabilities: ["game.observe"],
    maxResultBytes: 4 * 1_024,
  };
  readonly actions: Readonly<Record<string, AdapterActionDefinition>> = {
    gated_write: {
      description: "A test-only write controlled by a promise gate.",
      inputSchema: gatedInputSchema,
      outputSchema: gatedResultSchema,
      effectKind: "write",
      dryRunSemantics: "exact",
      requiredCapabilities: ["game.act.gated_write"],
      maxResultBytes: 4 * 1_024,
      writeConcurrency: { kind: "resource-serial", resourceKey: "gated-world" },
      adapterErrorCodes: ["OUT_OF_BOUNDS"],
      requiresExpectedRevision: false,
      reconciliation: "unsupported",
    },
  };

  commitEntries = 0;
  completedWrites = 0;
  dryRunCalls = 0;
  readonly #entryWaiters: Array<{ target: number; signal: Deferred<void> }> = [];
  readonly #gates: Deferred<void>[] = [];

  async observe(): Promise<unknown> {
    return {
      commitEntries: this.commitEntries,
      completedWrites: this.completedWrites,
      dryRunCalls: this.dryRunCalls,
    };
  }

  async getStateRevision(): Promise<number> {
    return this.completedWrites;
  }

  async execute(
    action: string,
    input: unknown,
    mode: BridgeMode,
  ): Promise<unknown> {
    if (action !== "gated_write") {
      throw new Error("Unexpected gated-adapter action.");
    }
    const parsed = gatedInputSchema.parse(input);
    if (mode === "dry-run") {
      this.dryRunCalls += 1;
      return { applied: false, behavior: parsed.behavior };
    }

    const gate = parsed.behavior === "wait" ? deferred<void>() : undefined;
    if (gate !== undefined) {
      this.#gates.push(gate);
    }
    this.commitEntries += 1;
    this.#notifyEntries();

    if (gate !== undefined) {
      await gate.promise;
    }
    if (parsed.behavior === "known-error") {
      throw new AdapterExecutionError("OUT_OF_BOUNDS");
    }
    if (parsed.behavior === "unknown-error") {
      throw new Error("test-only unknown adapter failure");
    }
    this.completedWrites += 1;
    return { applied: true, completedWrites: this.completedWrites };
  }

  waitForCommitEntries(target: number): Promise<void> {
    if (this.commitEntries >= target) {
      return Promise.resolve();
    }
    const signal = deferred<void>();
    this.#entryWaiters.push({ target, signal });
    return signal.promise;
  }

  releaseNext(): void {
    const gate = this.#gates.shift();
    if (gate === undefined) {
      throw new Error("No gated adapter action is waiting.");
    }
    gate.resolve();
  }

  #notifyEntries(): void {
    for (let index = this.#entryWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#entryWaiters[index]!;
      if (this.commitEntries >= waiter.target) {
        this.#entryWaiters.splice(index, 1);
        waiter.signal.resolve();
      }
    }
  }
}

interface HardeningHarness {
  adapter: GatedAdapter;
  audit: MemoryAuditSink;
  bridge: GameBridge;
  control: ReturnType<GameBridge["createLocalControlPlane"]>;
  now: { value: number };
  sessions: SessionManager;
}

function createHarness(
  options: {
    maxSessions?: number;
    terminalRetentionMs?: number;
    maxRequestsPerSession?: number;
    maxInFlightWrites?: number;
  } = {},
): HardeningHarness {
  const now = { value: 0 };
  let sessionSequence = 0;
  const sessions = new SessionManager({
    clock: () => now.value,
    idGenerator: () => `session-${++sessionSequence}`,
    maxSessions: options.maxSessions ?? 8,
    terminalRetentionMs: options.terminalRetentionMs ?? 10,
    maxRequestsPerSession: options.maxRequestsPerSession ?? 16,
  });
  const adapter = new GatedAdapter();
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const audit = new MemoryAuditSink();
  const bridge = new GameBridge({
    registry,
    sessions,
    safetyLatch: new SafetyLatch({
      maxInFlightWrites: options.maxInFlightWrites ?? 2,
    }),
    auditSink: audit,
    grantProvider: gatedGrantProvider,
    clock: () => now.value,
  });
  return {
    adapter,
    audit,
    bridge,
    control: bridge.createLocalControlPlane(),
    now,
    sessions,
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

function openRequest(requestId: string, ttlMs = 1_000): RequestEnvelope {
  return envelope(requestId, "session.open", {
    adapterId: "gated-world",
    capabilities: ["game.observe", "game.act.gated_write", "safety.stop"],
    ttlMs,
  });
}

async function openSession(
  harness: HardeningHarness,
  requestId: string,
  ttlMs = 1_000,
): Promise<string> {
  const response = await harness.bridge.handle(openRequest(requestId, ttlMs), {
    transport: "local",
  });
  expect(response.ok).toBe(true);
  return (response as { result: { sessionId: string } }).result.sessionId;
}

function writeRequest(
  requestId: string,
  sessionId: string,
  behavior: z.infer<typeof gatedInputSchema>["behavior"],
  mode: "dry-run" | "commit" = "commit",
): RequestEnvelope {
  return envelope(
    requestId,
    "game.act",
    {
      adapterId: "gated-world",
      gameAction: "gated_write",
      input: { behavior },
    },
    { sessionId, mode },
  );
}

function expectError(response: BridgeResponse, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe(code);
  }
}

function handleLocal(
  harness: HardeningHarness,
  request: RequestEnvelope,
): Promise<BridgeResponse> {
  return harness.bridge.handle(request, { transport: "local" });
}

describe("bounded cache and local safety hardening", () => {
  it("fails closed on generated session ID collisions without replacing the active session", async () => {
    const collidingId = "Bearer-review-secret-123";
    const directSessions = new SessionManager({
      idGenerator: () => collidingId,
      maxSessions: 2,
      terminalRetentionMs: 10,
      maxRequestsPerSession: 1,
    });
    const first = directSessions.open(
      TEST_OWNER,
      "first-adapter",
      ["first-capability"],
      1_000,
      DIRECT_TEST_GRANT,
    );

    expect(() =>
      directSessions.open(
        TEST_OWNER,
        "second-adapter",
        ["second-capability"],
        1_000,
        DIRECT_TEST_GRANT,
      ),
    ).toThrow(SessionIdCollisionError);
    expect(directSessions.size).toBe(1);
    expect(directSessions.find(collidingId)).toBe(first);
    expect(first.adapterId).toBe("first-adapter");
    expect([...first.capabilities]).toEqual(["first-capability"]);
    expect(Reflect.set(first, "capabilities", new Set(["injected"]))).toBe(false);
    expect(Reflect.set(first, "actionBudgetRemaining", 999)).toBe(false);
    expect(
      Reflect.set(first, "perActionBudgetRemaining", new Map([["injected", 999]])),
    ).toBe(false);
    expect([...first.capabilities]).toEqual(["first-capability"]);
    expect(first.actionBudgetRemaining).toBe(DIRECT_TEST_GRANT.totalActionBudget);

    const now = { value: 0 };
    const sessions = new SessionManager({
      clock: () => now.value,
      idGenerator: () => collidingId,
      maxSessions: 2,
      terminalRetentionMs: 10,
      maxRequestsPerSession: 1,
    });
    const adapter = new GatedAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const audit = new MemoryAuditSink();
    const bridge = new GameBridge({
      registry,
      sessions,
      auditSink: audit,
      grantProvider: gatedGrantProvider,
      clock: () => now.value,
    });

    const opened = await bridge.handle(openRequest("open-first"), {
      transport: "local",
    });
    expect(opened.ok).toBe(true);
    const retained = sessions.find(collidingId);

    const collision = await bridge.handle(openRequest("open-second"), {
      transport: "local",
    });
    expectError(collision, "INTERNAL_ERROR");
    expect(JSON.stringify(collision)).not.toContain(collidingId);
    expect(sessions.size).toBe(1);
    expect(sessions.find(collidingId)).toBe(retained);
    expect(JSON.stringify(audit.events)).not.toContain(collidingId);
  });

  it("sweeps retained terminal sessions before refusing new capacity", async () => {
    const harness = createHarness({ maxSessions: 2, terminalRetentionMs: 10 });
    const firstId = await openSession(harness, "open-1");
    const secondId = await openSession(harness, "open-2");

    expectError(
      await harness.bridge.handle(openRequest("open-full"), { transport: "local" }),
      "RESOURCE_CAPACITY",
    );
    expect(harness.sessions.size).toBe(2);
    expect(harness.sessions.find(firstId)).toBeDefined();
    expect(harness.sessions.find(secondId)).toBeDefined();
    expect(harness.sessions.active(secondId).errorCode).toBeUndefined();

    expect(
      (
        await handleLocal(harness,
          envelope("close-1", "session.close", {}, { sessionId: firstId }),
        )
      ).ok,
    ).toBe(true);
    harness.now.value = 9;
    expectError(
      await harness.bridge.handle(openRequest("open-too-early"), { transport: "local" }),
      "RESOURCE_CAPACITY",
    );

    harness.now.value = 10;
    const replacement = await harness.bridge.handle(openRequest("open-after-retention"), {
      transport: "local",
    });
    expect(replacement.ok).toBe(true);
    expect(harness.sessions.find(firstId)).toBeUndefined();
    expect(harness.sessions.find(secondId)).toBeDefined();
    expect(harness.sessions.size).toBe(2);
  });

  it("retains closed and expired sessions until each retention deadline", () => {
    const now = { value: 0 };
    let sequence = 0;
    const sessions = new SessionManager({
      clock: () => now.value,
      idGenerator: () => `retained-${++sequence}`,
      maxSessions: 3,
      terminalRetentionMs: 10,
      maxRequestsPerSession: 1,
    });
    const closed = sessions.open(TEST_OWNER, "gated-world", [], 100, DIRECT_TEST_GRANT);
    sessions.close(closed);
    const expired = sessions.open(TEST_OWNER, "gated-world", [], 5, DIRECT_TEST_GRANT);

    now.value = 5;
    expect(sessions.sweep()).toBe(0);
    expect(sessions.find(closed.id)).toBeDefined();
    expect(sessions.find(expired.id)).toBeDefined();

    now.value = 10;
    expect(sessions.sweep()).toBe(1);
    expect(sessions.find(closed.id)).toBeUndefined();
    expect(sessions.find(expired.id)).toBeDefined();

    now.value = 15;
    expect(sessions.sweep()).toBe(1);
    expect(sessions.find(expired.id)).toBeUndefined();
  });

  it("keeps completed idempotency evidence when request capacity is full", async () => {
    const harness = createHarness({ maxRequestsPerSession: 1 });
    const sessionId = await openSession(harness, "open-cache");
    const firstRequest = writeRequest("cached-write", sessionId, "success");

    const first = await handleLocal(harness, firstRequest);
    const replay = await handleLocal(harness, firstRequest);
    expect(replay).toEqual(first);
    expect(harness.adapter.commitEntries).toBe(1);
    expect(harness.adapter.completedWrites).toBe(1);
    expect(harness.sessions.find(sessionId)?.requests.size).toBe(1);

    expectError(
      await handleLocal(harness, writeRequest("new-at-capacity", sessionId, "success")),
      "RESOURCE_CAPACITY",
    );
    expect(harness.adapter.commitEntries).toBe(1);

    const close = await handleLocal(harness,
      envelope("close-at-capacity", "session.close", {}, { sessionId }),
    );
    expect(close.ok).toBe(true);
    expect(harness.sessions.find(sessionId)?.requests.size).toBe(1);
  });

  it("never evicts an in-flight request and keeps local stop and close available", async () => {
    const harness = createHarness({
      maxRequestsPerSession: 1,
      terminalRetentionMs: 10,
    });
    const sessionId = await openSession(harness, "open-in-flight");
    const waitingRequest = writeRequest("waiting", sessionId, "wait");
    const first = handleLocal(harness, waitingRequest);
    await harness.adapter.waitForCommitEntries(1);
    const duplicate = handleLocal(harness, waitingRequest);

    expectError(
      await handleLocal(harness, writeRequest("blocked-by-cache", sessionId, "success")),
      "RESOURCE_CAPACITY",
    );
    expectError(
      await handleLocal(harness, writeRequest("waiting", sessionId, "success")),
      "REQUEST_ID_REUSED",
    );
    expect(harness.adapter.commitEntries).toBe(1);

    const stop = await harness.control.stopSafety();
    expect(stop).toMatchObject({ stopped: true, inFlightWrites: 1 });
    const refusedResume = await harness.control.resumeSafety(stop.stopGeneration);
    expect(refusedResume).toMatchObject({
      resumed: false,
      reason: "writes-in-flight",
      inFlightWrites: 1,
    });
    const close = await handleLocal(harness,
      envelope("close-while-full", "session.close", {}, { sessionId }),
    );
    expect(close.ok).toBe(true);
    expect(harness.sessions.find(sessionId)?.requests.size).toBe(1);

    harness.now.value = 10;
    expect(harness.sessions.sweep()).toBe(0);
    expect(harness.sessions.find(sessionId)).toBeDefined();

    harness.adapter.releaseNext();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);
    expect(duplicateResponse).toEqual(firstResponse);
    expect(harness.adapter.commitEntries).toBe(1);
    expect(harness.control.getSafetyStatus()).toMatchObject({
      stopped: true,
      inFlightWrites: 0,
    });
    expect((await harness.control.resumeSafety(stop.stopGeneration)).resumed).toBe(true);
    expect(harness.sessions.sweep()).toBe(1);

    const localAudit = harness.audit.events.filter((event) => event.action.endsWith(".local"));
    expect(localAudit.map((event) => [event.action, event.decision])).toEqual([
      ["safety.stop.local", "allow"],
      ["safety.resume.local", "deny"],
      ["safety.resume.authorization.local", "allow"],
    ]);
    expect(JSON.stringify(localAudit)).not.toContain(sessionId);
  });

  it("rejects excess commit concurrency before the adapter but permits dry-run", async () => {
    const harness = createHarness({ maxInFlightWrites: 1 });
    const sessionId = await openSession(harness, "open-write-limit");
    const waiting = handleLocal(harness, writeRequest("write-1", sessionId, "wait"));
    await harness.adapter.waitForCommitEntries(1);

    expect(harness.control.getSafetyStatus()).toMatchObject({
      inFlightWrites: 1,
      maxInFlightWrites: 1,
    });
    expectError(
      await handleLocal(harness, writeRequest("write-2", sessionId, "success")),
      "RESOURCE_CAPACITY",
    );
    expect(harness.adapter.commitEntries).toBe(1);

    const stopped = await harness.control.stopSafety();
    expect(stopped).toMatchObject({ stopped: true, inFlightWrites: 1 });
    expectError(
      await handleLocal(harness, writeRequest("write-after-stop", sessionId, "success")),
      "SAFETY_STOPPED",
    );
    expect(harness.adapter.commitEntries).toBe(1);
    expect(await harness.control.resumeSafety(stopped.stopGeneration)).toMatchObject({
      resumed: false,
      reason: "writes-in-flight",
    });

    const dryRun = await handleLocal(harness,
      writeRequest("write-preview", sessionId, "success", "dry-run"),
    );
    expect(dryRun.ok && dryRun.result).toMatchObject({ applied: false });
    expect(harness.adapter.dryRunCalls).toBe(1);
    expect(harness.control.getSafetyStatus().inFlightWrites).toBe(1);

    harness.adapter.releaseNext();
    expect((await waiting).ok).toBe(true);
    expect(harness.control.getSafetyStatus().inFlightWrites).toBe(0);
    expect((await harness.control.resumeSafety(stopped.stopGeneration)).resumed).toBe(true);
  });

  it("releases write capacity after known and unknown adapter errors", async () => {
    const harness = createHarness({ maxInFlightWrites: 1 });
    const sessionId = await openSession(harness, "open-errors");

    expectError(
      await handleLocal(harness, writeRequest("known-error", sessionId, "known-error")),
      "ADAPTER_REJECTED",
    );
    expect(harness.control.getSafetyStatus().inFlightWrites).toBe(0);

    expect(
      (await handleLocal(harness, writeRequest("after-known-error", sessionId, "success"))).ok,
    ).toBe(true);

    expectError(
      await handleLocal(harness, writeRequest("unknown-error", sessionId, "unknown-error")),
      "OUTCOME_UNKNOWN",
    );
    expect(harness.control.getSafetyStatus().inFlightWrites).toBe(0);
    expect(harness.control.getHealthStatus().runtime.status).toBe("faulted");

    expectError(
      await handleLocal(harness, writeRequest("after-errors", sessionId, "success")),
      "RUNTIME_UNAVAILABLE",
    );
    expect(harness.control.getSafetyStatus().inFlightWrites).toBe(0);
  });
});
