import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AdapterExecutionError,
  AdapterRegistry,
  AdapterRuntimeError,
  GameBridge,
  MemoryAuditSink,
  MockGameAdapter,
  SafetyLatch,
  SessionManager,
  describeAdapter,
  type AdapterActionDefinition,
  type AdapterHealthStatus,
  type AdapterObservationDefinition,
  type AuditEvent,
  type AuditSink,
  type BridgeMode,
  type BridgeResponse,
  type GameAdapter,
  type RequestContext,
  type RequestEnvelope,
} from "../src/index.js";

const local = Object.freeze({ transport: "local" } satisfies RequestContext);

function request(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  options: { sessionId?: string; mode?: BridgeMode } = {},
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

function expectError(response: BridgeResponse, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe(code);
}

async function open(
  bridge: GameBridge,
  adapterId: string,
  capabilities: string[],
): Promise<string> {
  const response = await bridge.handle(
    request("open", "session.open", { adapterId, capabilities }),
    local,
  );
  expect(response.ok).toBe(true);
  return (response as { result: { sessionId: string } }).result.sessionId;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const contractInputSchema = z.object({ wait: z.boolean().optional() }).strict();
const contractOutputSchema = z
  .object({
    applied: z.boolean(),
    stateRevision: z.number().int().nonnegative(),
    text: z.string().optional(),
  })
  .strict();
const contractObservationSchema = z
  .object({ stateRevision: z.number().int().nonnegative() })
  .strict();

type ContractBehavior =
  | "success"
  | "wait"
  | "explicit-reject"
  | "invalid-output"
  | "oversized-output"
  | "outcome-unknown";

class ContractTestAdapter implements GameAdapter {
  readonly id = "contract-test";
  readonly displayName = "Closed contract test adapter";
  readonly observation: AdapterObservationDefinition;
  readonly actions: Readonly<Record<string, AdapterActionDefinition>>;
  readonly entered = deferred();
  readonly release = deferred();
  entries = 0;
  revision = 0;
  healthState: AdapterHealthStatus = "ready";

  constructor(
    readonly behavior: ContractBehavior = "success",
    options: { maxResultBytes?: number; invalidObservation?: boolean } = {},
  ) {
    this.observation = {
      description: "Observe the test revision without external state.",
      outputSchema: contractObservationSchema,
      effectKind: "read",
      concurrency: "parallel",
      requiredCapabilities: ["game.observe"],
      maxResultBytes: 128,
    };
    this.actions = {
      write: {
        description: "Execute one bounded test write.",
        inputSchema: contractInputSchema,
        outputSchema: contractOutputSchema,
        effectKind: "write",
        dryRunSemantics: "exact",
        requiredCapabilities: ["game.act.write"],
        maxResultBytes: options.maxResultBytes ?? 128,
        writeConcurrency: { kind: "resource-serial", resourceKey: "world" },
        adapterErrorCodes: ["DENIED"],
        requiresExpectedRevision: false,
        reconciliation: "future",
      },
    };
    if (options.invalidObservation) {
      this.observe = async () => ({ authorization: "Bearer-output-sentinel" });
    }
  }

  async observe(): Promise<unknown> {
    return { stateRevision: this.revision };
  }

  async getStateRevision(): Promise<number> {
    return this.revision;
  }

  async execute(_action: string, _input: unknown, mode: BridgeMode): Promise<unknown> {
    if (mode === "dry-run") return { applied: false, stateRevision: this.revision };
    this.entries += 1;
    this.entered.resolve();
    if (this.behavior === "wait") await this.release.promise;
    if (this.behavior === "explicit-reject") throw new AdapterExecutionError("DENIED");
    if (this.behavior === "outcome-unknown") {
      throw new AdapterRuntimeError("outcome-unknown");
    }
    this.revision += 1;
    if (this.behavior === "invalid-output") {
      return { applied: true, stateRevision: this.revision, secret: "Bearer-output-sentinel" };
    }
    if (this.behavior === "oversized-output") {
      return { applied: true, stateRevision: this.revision, text: "x".repeat(512) };
    }
    return { applied: true, stateRevision: this.revision };
  }

  health(): AdapterHealthStatus {
    return this.healthState;
  }
}

function testGrantProvider(options: { total?: number; perAction?: number } = {}) {
  return {
    grant(grantRequest: {
      adapter: GameAdapter;
      context: RequestContext;
      requestedCapabilities: readonly string[];
      requestedTtlMs?: number;
    }) {
      if (
        grantRequest.context.transport !== "local" ||
        grantRequest.adapter.id !== "contract-test"
      ) {
        return { allowed: false as const };
      }
      return {
        allowed: true as const,
        capabilities: [...new Set(grantRequest.requestedCapabilities)].sort(),
        scope: { kind: "test-resource" as const, resourceId: "contract-world" },
        ttlMs: grantRequest.requestedTtlMs ?? 60_000,
        totalActionBudget: options.total ?? 16,
        perActionBudgets: { write: options.perAction ?? 16 },
      };
    },
  };
}

function contractHarness(
  adapter: ContractTestAdapter,
  options: {
    auditSink?: AuditSink;
    maxInFlightWrites?: number;
    totalBudget?: number;
    perActionBudget?: number;
  } = {},
) {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const sessions = new SessionManager({ idGenerator: () => "contract-session" });
  const audit = options.auditSink ?? new MemoryAuditSink();
  const bridge = new GameBridge({
    registry,
    sessions,
    auditSink: audit,
    grantProvider: testGrantProvider({
      ...(options.totalBudget === undefined ? {} : { total: options.totalBudget }),
      ...(options.perActionBudget === undefined
        ? {}
        : { perAction: options.perActionBudget }),
    }),
    safetyLatch: new SafetyLatch({
      maxInFlightWrites: options.maxInFlightWrites ?? 4,
    }),
  });
  return { audit, bridge, registry, sessions };
}

function writeRequest(
  requestId: string,
  sessionId: string,
  mode: BridgeMode = "commit",
): RequestEnvelope {
  return request(
    requestId,
    "game.act",
    { adapterId: "contract-test", gameAction: "write", input: {} },
    { sessionId, mode },
  );
}

class ToggleAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  fail = false;
  status: "ready" | "degraded" | "full" = "ready";

  write(event: AuditEvent): void {
    if (this.fail) throw new Error("test audit failure");
    this.events.push(event);
  }

  isWritable(): boolean {
    return this.status !== "full";
  }

  health(): Readonly<{
    status: "ready" | "degraded" | "full";
    outstandingWrites: number;
  }> {
    return Object.freeze({ status: this.status, outstandingWrites: 0 });
  }
}

describe("Adapter Contract v2", () => {
  it("snapshots and serializes a closed adapter manifest at registration", () => {
    const adapter = new ContractTestAdapter();
    const sourceInputSchema = z
      .object({ nested: z.object({ value: z.string() }).strict() })
      .strict();
    (adapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...adapter.actions.write!,
      inputSchema: sourceInputSchema,
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const registered = registry.get(adapter.id)!;
    const mutableAction = adapter.actions.write! as AdapterActionDefinition;
    (mutableAction.requiredCapabilities as string[]).push("game.act.injected");
    (adapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...mutableAction,
      inputSchema: z.unknown(),
      requiredCapabilities: ["game.act.injected"],
    };
    (sourceInputSchema._def.shape as unknown as Record<string, z.ZodType>).nested =
      z.unknown();

    expect(registered.actions.write!.requiredCapabilities).toEqual(["game.act.write"]);
    expect(
      registered.actions.write!.inputSchema.safeParse({ nested: { unexpected: true } }).success,
    ).toBe(false);
    expect(
      registered.actions.write!.inputSchema.safeParse({ nested: { value: "still-strict" } })
        .success,
    ).toBe(true);
    const description = describeAdapter(registered);
    expect(description.actions.write).toMatchObject({
      effectKind: "write",
      dryRunSemantics: "exact",
      requiredCapabilities: ["game.act.write"],
      maxResultBytes: 128,
      requiresExpectedRevision: false,
      reconciliation: "future",
      writeConcurrency: { kind: "resource-serial", resourceKey: "world" },
      adapterErrorCodes: ["DENIED"],
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    });
    expect(description.observation).toMatchObject({
      effectKind: "read",
      concurrency: "parallel",
    });
    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain("_def");
    expect(serialized).not.toContain("safeParse");

    const mockRegistry = new AdapterRegistry();
    mockRegistry.register(new MockGameAdapter());
    expect(
      mockRegistry
        .get("mock-world")!
        .actions.move!.inputSchema.safeParse({ dx: 0, dy: 0, dz: 0 }).success,
    ).toBe(false);

    const invalid = new ContractTestAdapter();
    (invalid.actions as Record<string, AdapterActionDefinition>).write = {
      ...invalid.actions.write!,
      inputSchema: z.string().transform((value) => value.length),
    };
    expect(() => new AdapterRegistry().register(invalid)).toThrow(/JSON Schema/u);
  });

  it("uses the trusted mock profile instead of treating requested capabilities as grants", async () => {
    const registry = new AdapterRegistry();
    registry.register(new MockGameAdapter());
    const bridge = new GameBridge({
      registry,
      sessions: new SessionManager({ idGenerator: () => "grant-session" }),
    });
    const approved = await bridge.handle(
      request("grant-approved", "session.open", {
        adapterId: "mock-world",
        capabilities: ["game.observe", "game.act.move", "safety.stop"],
      }),
      local,
    );
    expect(approved.ok && approved.result).toMatchObject({
      capabilities: ["game.act.move", "game.observe", "safety.stop"],
      scope: { kind: "mock-world", resourceId: "tiny-world-v1" },
      actionBudgetRemaining: 128,
    });
    expectError(
      await bridge.handle(
        request("grant-denied", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe", "game.act.admin"],
        }),
        local,
      ),
      "CAPABILITY_DENIED",
    );
  });

  it("returns revisions and charges only dispatched commit attempts once", async () => {
    const registry = new AdapterRegistry();
    const adapter = new MockGameAdapter();
    registry.register(adapter);
    const sessions = new SessionManager({ idGenerator: () => "revision-session" });
    const bridge = new GameBridge({ registry, sessions });
    const sessionId = await open(bridge, "mock-world", [
      "game.observe",
      "game.act.place_block",
    ]);
    const observe = (id: string) =>
      bridge.handle(
        request(id, "game.observe", { adapterId: "mock-world" }, { sessionId }),
        local,
      );
    expect((await observe("revision-zero")).ok).toBe(true);
    const preview = await bridge.handle(
      request(
        "place-preview",
        "game.act",
        {
          adapterId: "mock-world",
          gameAction: "place_block",
          input: { x: 1, y: 1, z: 1, blockType: "stone" },
        },
        { sessionId, mode: "dry-run" },
      ),
      local,
    );
    expect(preview.ok && preview.result).toMatchObject({ applied: false, stateRevision: 0 });
    const first = request(
      "place-first",
      "game.act",
      {
        adapterId: "mock-world",
        gameAction: "place_block",
        input: { x: 1, y: 1, z: 1, blockType: "stone" },
        expectedRevision: 0,
      },
      { sessionId },
    );
    expect((await bridge.handle(first, local)).ok).toBe(true);
    expect((await bridge.handle(first, local)).ok).toBe(true);
    expectError(
      await bridge.handle(
        request(
          "place-stale",
          "game.act",
          {
            adapterId: "mock-world",
            gameAction: "place_block",
            input: { x: 2, y: 1, z: 1, blockType: "dirt" },
            expectedRevision: 0,
          },
          { sessionId },
        ),
        local,
      ),
      "REVISION_CONFLICT",
    );
    const rejected = request(
      "place-occupied",
      "game.act",
      {
        adapterId: "mock-world",
        gameAction: "place_block",
        input: { x: 1, y: 1, z: 1, blockType: "stone" },
        expectedRevision: 1,
      },
      { sessionId },
    );
    const rejectedResponse = await bridge.handle(rejected, local);
    expectError(rejectedResponse, "ADAPTER_REJECTED");
    if (!rejectedResponse.ok) {
      expect(rejectedResponse.error).toMatchObject({
        operationPhase: "adapter-rejected",
        adapterError: { code: "TARGET_OCCUPIED" },
      });
    }
    expect(await bridge.handle(rejected, local)).toEqual(rejectedResponse);
    expect((await observe("revision-one")).ok).toBe(true);
    expect(sessions.find(sessionId)).toMatchObject({ actionBudgetRemaining: 126 });
  });

  it("serializes one resource write independently of the global write bound", async () => {
    const adapter = new ContractTestAdapter("wait");
    const { bridge } = contractHarness(adapter, { maxInFlightWrites: 4 });
    const sessionId = await open(bridge, adapter.id, ["game.act.write", "safety.stop"]);
    const first = bridge.handle(writeRequest("write-first", sessionId), local);
    await adapter.entered.promise;
    expectError(
      await bridge.handle(writeRequest("write-second", sessionId), local),
      "RESOURCE_CAPACITY",
    );
    expect(adapter.entries).toBe(1);
    const stopped = await bridge.createLocalControlPlane().stopSafety();
    expectError(
      await bridge.handle(writeRequest("write-stopped", sessionId), local),
      "SAFETY_STOPPED",
    );
    adapter.release.resolve();
    expect((await first).ok).toBe(true);
    expect(stopped.inFlightWrites).toBe(1);
    expect(bridge.createLocalControlPlane().getSafetyStatus().inFlightWrites).toBe(0);
  });

  it("reserves bounded action budgets before dispatch without double-charging replays", async () => {
    const adapter = new ContractTestAdapter("explicit-reject");
    const { bridge, sessions } = contractHarness(adapter, {
      totalBudget: 1,
      perActionBudget: 1,
    });
    const sessionId = await open(bridge, adapter.id, ["game.act.write"]);
    const rejected = writeRequest("budget-rejected", sessionId);
    const first = await bridge.handle(rejected, local);
    expectError(first, "ADAPTER_REJECTED");
    expect(await bridge.handle(rejected, local)).toEqual(first);
    expect(adapter.entries).toBe(1);
    expect(sessions.find(sessionId)).toMatchObject({ actionBudgetRemaining: 0 });
    expectError(
      await bridge.handle(writeRequest("budget-exhausted", sessionId), local),
      "RESOURCE_CAPACITY",
    );
    expect(adapter.entries).toBe(1);
  });

  it("fails closed on invalid or oversized adapter results without leaking values", async () => {
    for (const [behavior, expectedCode, maxResultBytes] of [
      ["invalid-output", "ADAPTER_OUTPUT_INVALID", 128],
      ["oversized-output", "ADAPTER_RESULT_TOO_LARGE", 64],
    ] as const) {
      const adapter = new ContractTestAdapter(behavior, { maxResultBytes });
      const { bridge } = contractHarness(adapter);
      const sessionId = await open(bridge, adapter.id, ["game.act.write"]);
      const response = await bridge.handle(writeRequest(`write-${behavior}`, sessionId), local);
      expectError(response, expectedCode);
      expect(JSON.stringify(response)).not.toContain("Bearer-output-sentinel");
      expect(JSON.stringify(response)).not.toContain("x".repeat(64));
      expect(bridge.getHealthStatus().runtime.status).toBe("faulted");
    }

    const observationAdapter = new ContractTestAdapter("success", {
      invalidObservation: true,
    });
    const { bridge } = contractHarness(observationAdapter);
    const sessionId = await open(bridge, observationAdapter.id, ["game.observe"]);
    const response = await bridge.handle(
      request(
        "invalid-observation",
        "game.observe",
        { adapterId: observationAdapter.id },
        { sessionId },
      ),
      local,
    );
    expectError(response, "ADAPTER_OUTPUT_INVALID");
    expect(JSON.stringify(response)).not.toContain("Bearer-output-sentinel");
  });

  it("exposes closed health states and keeps safe observation usable after audit degradation", async () => {
    const audit = new ToggleAuditSink();
    const adapter = new ContractTestAdapter();
    const { bridge } = contractHarness(adapter, { auditSink: audit });
    const sessionId = await open(bridge, adapter.id, ["game.observe", "game.act.write"]);
    audit.fail = true;
    audit.status = "degraded";
    const observed = await bridge.handle(
      request(
        "degraded-observe",
        "game.observe",
        { adapterId: adapter.id },
        { sessionId },
      ),
      local,
    );
    expect(observed.ok && observed.result).toEqual({ stateRevision: 0 });
    expect(bridge.getHealthStatus()).toMatchObject({
      runtime: { status: "ready" },
      adapter: { status: "ready" },
      audit: { status: "degraded" },
      safety: { stopped: false },
    });

    audit.fail = false;
    audit.status = "full";
    expectError(
      await bridge.handle(writeRequest("audit-full-write", sessionId), local),
      "RESOURCE_CAPACITY",
    );
    adapter.healthState = "faulted";
    expect(bridge.getHealthStatus()).toMatchObject({
      runtime: { status: "faulted" },
      adapter: { status: "faulted" },
      audit: { status: "full" },
    });

    const quiescingAdapter = new ContractTestAdapter();
    const quiescingHarness = contractHarness(quiescingAdapter);
    const quiescingSession = await open(
      quiescingHarness.bridge,
      quiescingAdapter.id,
      ["game.act.write"],
    );
    quiescingHarness.bridge.beginQuiescing();
    expectError(
      await quiescingHarness.bridge.handle(
        writeRequest("quiescing-write", quiescingSession),
        local,
      ),
      "RUNTIME_UNAVAILABLE",
    );
    expect(quiescingAdapter.entries).toBe(0);
  });

  it("caches outcome-unknown without retrying and blocks later commits", async () => {
    const adapter = new ContractTestAdapter("outcome-unknown");
    const { bridge } = contractHarness(adapter);
    const sessionId = await open(bridge, adapter.id, ["game.act.write"]);
    const operation = writeRequest("unknown-operation", sessionId);
    const first = await bridge.handle(operation, local);
    expectError(first, "OUTCOME_UNKNOWN");
    expect(first.ok ? undefined : first.error.operationPhase).toBe("outcome-unknown");
    expect(await bridge.handle(operation, local)).toEqual(first);
    expect(adapter.entries).toBe(1);
    expectError(
      await bridge.handle(writeRequest("blocked-after-unknown", sessionId), local),
      "RUNTIME_UNAVAILABLE",
    );
    bridge.beginQuiescing();
    expect(bridge.getHealthStatus().runtime.status).toBe("faulted");
  });
});
