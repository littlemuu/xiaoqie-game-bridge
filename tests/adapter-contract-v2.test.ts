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
  type CapabilityGrantProvider,
  type GameAdapter,
  type RequestContext,
  type RequestEnvelope,
  operatorHealthStatusSchema,
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
  | "revision-reject"
  | "pre-dispatch-unavailable"
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
      concurrency: { kind: "parallel" },
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
    if (this.behavior === "revision-reject") {
      throw new AdapterExecutionError("REVISION_CONFLICT");
    }
    if (this.behavior === "pre-dispatch-unavailable") {
      throw new AdapterRuntimeError("unavailable", "not-dispatched");
    }
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

class CommitSignalPreviewAdapter extends ContractTestAdapter {
  previewCommitMutations = 0;

  constructor(behavior: ContractBehavior = "success") {
    super(behavior);
    (this.actions as Record<string, AdapterActionDefinition>).preview = {
      description: "Preview without accepting a commit signal.",
      inputSchema: contractInputSchema,
      outputSchema: contractOutputSchema,
      effectKind: "preview",
      dryRunSemantics: "exact",
      requiredCapabilities: ["game.act.preview"],
      maxResultBytes: 128,
      writeConcurrency: { kind: "none" },
      adapterErrorCodes: [],
      requiresExpectedRevision: false,
      reconciliation: "unsupported",
    };
  }

  override async execute(action: string, input: unknown, mode: BridgeMode): Promise<unknown> {
    if (action === "preview") {
      if (mode === "commit") this.previewCommitMutations += 1;
      return { applied: false, stateRevision: this.revision };
    }
    return super.execute(action, input, mode);
  }
}

class ReadOnlySerialAdapter implements GameAdapter {
  readonly id = "read-only-test";
  readonly displayName = "Pure read-only serial adapter";
  readonly observation: AdapterObservationDefinition = {
    description: "Observe one read-only value.",
    outputSchema: z.object({ value: z.number().int() }).strict(),
    effectKind: "read",
    concurrency: { kind: "serial" },
    requiredCapabilities: ["game.observe"],
    maxResultBytes: 128,
  };
  readonly actions = {};
  readonly entered = deferred();
  readonly release = deferred();

  async observe(): Promise<unknown> {
    this.entered.resolve();
    await this.release.promise;
    return { value: 1 };
  }
}

const readOnlyGrantProvider = {
  grant(grantRequest: {
    adapter: GameAdapter;
    context: RequestContext;
    requestedCapabilities: readonly string[];
    requestedTtlMs?: number;
  }) {
    if (
      grantRequest.context.transport !== "local" ||
      grantRequest.adapter.id !== "read-only-test"
    ) {
      return { allowed: false as const };
    }
    return {
      allowed: true as const,
      capabilities: [...new Set(grantRequest.requestedCapabilities)].sort(),
      scope: { kind: "read-only-test", resourceId: "read-only-world" },
      ttlMs: grantRequest.requestedTtlMs ?? 60_000,
      totalActionBudget: 0,
      perActionBudgets: {},
    };
  },
};

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
        scope: { kind: "contract-test", resourceId: "contract-world" },
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
    grantProvider?: CapabilityGrantProvider;
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
    grantProvider:
      options.grantProvider ??
      testGrantProvider({
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

class RawHealthAuditSink extends MemoryAuditSink {
  rawHealth: unknown = Object.freeze({ status: "ready", outstandingWrites: 0 });
  throwHealth = false;
  throwWrite = false;

  override write(event: AuditEvent): void {
    if (this.throwWrite) throw new Error("Bearer-audit-write-secret");
    super.write(event);
  }

  override health(): Readonly<{ status: "ready"; outstandingWrites: number }> {
    if (this.throwHealth) throw new Error("Bearer-audit-health-secret");
    return this.rawHealth as Readonly<{ status: "ready"; outstandingWrites: number }>;
  }
}

class RawHealthAdapter extends ContractTestAdapter {
  rawHealth: unknown = "ready";
  throwHealth = false;

  override health(): AdapterHealthStatus {
    if (this.throwHealth) throw new Error("Bearer-adapter-health-secret");
    return this.rawHealth as AdapterHealthStatus;
  }
}

class GatedStateChangeAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  readonly writeAuditEntered = deferred();
  readonly releaseWriteAudit = deferred();

  async write(event: AuditEvent): Promise<void> {
    if (event.action === "game.act") {
      this.writeAuditEntered.resolve();
      await this.releaseWriteAudit.promise;
    }
    this.events.push(event);
  }

  isWritable(): boolean {
    return true;
  }

  health(): Readonly<{ status: "ready"; outstandingWrites: number }> {
    return Object.freeze({ status: "ready", outstandingWrites: 0 });
  }
}

class ReservationCountingAuditSink extends MemoryAuditSink {
  reservations = 0;

  reserveWrite(): undefined {
    this.reservations += 1;
    return undefined;
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
      concurrency: { kind: "parallel" },
    });
    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain("_def");
    expect(serialized).not.toContain("safeParse");

    const registeredInput = registered.actions.write!.inputSchema as {
      readonly jsonSchema?: unknown;
      safeParse(value: unknown): { success: boolean };
    };
    expect(Object.isFrozen(registeredInput)).toBe(true);
    expect(Object.keys(registeredInput).sort()).toEqual(["jsonSchema", "safeParse"]);
    expect(Object.isFrozen(registeredInput.jsonSchema)).toBe(true);
    const registeredJson = registeredInput.jsonSchema as { properties?: unknown };
    expect(Object.isFrozen(registeredJson.properties)).toBe(true);
    expect(Reflect.set(registeredJson, "additionalProperties", true)).toBe(false);
    expect(
      Reflect.set(registeredInput, "safeParse", () => ({ success: true })),
    ).toBe(false);
    expect(registeredInput.safeParse({ nested: { unexpected: true } }).success).toBe(false);

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
    expect(() => new AdapterRegistry().register(invalid)).toThrow(/declarative/u);

    let refinementAllows = false;
    const closureBacked = new ContractTestAdapter();
    (closureBacked.actions as Record<string, AdapterActionDefinition>).write = {
      ...closureBacked.actions.write!,
      inputSchema: z.object({ value: z.string() }).refine(() => refinementAllows),
    };
    expect(() => new AdapterRegistry().register(closureBacked)).toThrow(/declarative/u);
    refinementAllows = true;

    for (const codeBearingSchema of [
      z.string().trim().min(1),
      z.string().overwrite((value) => value.trim()),
      z.coerce.number(),
      z.string().min(1, { when: () => true } as never),
    ]) {
      const codeBearing = new ContractTestAdapter();
      (codeBearing.actions as Record<string, AdapterActionDefinition>).write = {
        ...codeBearing.actions.write!,
        inputSchema: codeBearingSchema,
      };
      expect(() => new AdapterRegistry().register(codeBearing)).toThrow(/declarative/u);
    }

    const publicObservation = new ContractTestAdapter();
    (publicObservation as unknown as { observation: AdapterObservationDefinition }).observation = {
      ...publicObservation.observation,
      requiredCapabilities: [],
    };
    expect(() => new AdapterRegistry().register(publicObservation)).toThrow(/capability/u);

    const publicAction = new ContractTestAdapter();
    (publicAction.actions as Record<string, AdapterActionDefinition>).write = {
      ...publicAction.actions.write!,
      requiredCapabilities: [],
    };
    expect(() => new AdapterRegistry().register(publicAction)).toThrow(/capability/u);

    const resourceScheduledPreview = new CommitSignalPreviewAdapter();
    (resourceScheduledPreview.actions as Record<string, AdapterActionDefinition>).preview = {
      ...resourceScheduledPreview.actions.preview!,
      writeConcurrency: { kind: "resource-serial", resourceKey: "world" },
    };
    expect(() => new AdapterRegistry().register(resourceScheduledPreview)).toThrow(
      /non-write.*scheduling/u,
    );

    let malformedAccessorReads = 0;
    const accessorValues = ["game.act.write"];
    Object.defineProperty(accessorValues, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        malformedAccessorReads += 1;
        return "game.act.write";
      },
    });
    const malformedArrays = [new Array<string>(1), accessorValues];
    for (const malformed of malformedArrays) {
      const capabilityAdapter = new ContractTestAdapter();
      (capabilityAdapter.actions as Record<string, AdapterActionDefinition>).write = {
        ...capabilityAdapter.actions.write!,
        requiredCapabilities: malformed as unknown as readonly string[],
      };
      expect(() => new AdapterRegistry().register(capabilityAdapter)).toThrow(/string array/u);

      const errorCodeAdapter = new ContractTestAdapter();
      (errorCodeAdapter.actions as Record<string, AdapterActionDefinition>).write = {
        ...errorCodeAdapter.actions.write!,
        adapterErrorCodes: malformed as unknown as readonly string[],
      };
      expect(() => new AdapterRegistry().register(errorCodeAdapter)).toThrow(/string array/u);
    }
    expect(malformedAccessorReads).toBe(0);
  });

  it("captures one health member and rejects defined non-function values", () => {
    for (const malformed of [
      "ready",
      Promise.resolve("ready"),
      { then: () => undefined },
    ]) {
      const adapter = new ContractTestAdapter();
      Object.defineProperty(adapter, "health", {
        configurable: true,
        enumerable: true,
        value: malformed,
      });
      expect(() => new AdapterRegistry().register(adapter)).toThrow(/health/u);
    }

    const stateful = new ContractTestAdapter();
    let healthReads = 0;
    Object.defineProperty(stateful, "health", {
      configurable: true,
      get: () => {
        healthReads += 1;
        return healthReads === 1 ? () => "ready" as const : Promise.resolve("ready");
      },
    });
    const registry = new AdapterRegistry();
    registry.register(stateful);
    expect(healthReads).toBe(1);
    expect(registry.get(stateful.id)!.health!()).toBe("ready");
    expect(healthReads).toBe(1);
  });

  it("bounds the registry at the operator-visible adapter capacity before insertion", () => {
    const registry = new AdapterRegistry();
    const adapter = (index: number): GameAdapter => ({
      id: `capacity-${index.toString().padStart(2, "0")}`,
      displayName: "a",
      observation: {
        description: "o",
        outputSchema: z.boolean(),
        effectKind: "read",
        concurrency: { kind: "parallel" },
        requiredCapabilities: ["game.observe"],
        maxResultBytes: 1,
      },
      actions: {},
      observe: async () => true,
    });
    for (let index = 0; index < 64; index += 1) registry.register(adapter(index));
    expect(registry.list()).toHaveLength(64);
    expect(() => registry.register(adapter(64))).toThrow(/capacity/u);
    expect(registry.list()).toHaveLength(64);
  });

  it("isolates JSON snapshots from metadata and rejects custom or lossy emitters", () => {
    const defaultSchema = z.string().meta({ default: "injected" });
    const defaultAdapter = new ContractTestAdapter();
    (defaultAdapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...defaultAdapter.actions.write!,
      inputSchema: defaultSchema,
    };
    const defaultRegistry = new AdapterRegistry();
    defaultRegistry.register(defaultAdapter);
    const defaultSnapshot = defaultRegistry.get(defaultAdapter.id)!.actions.write!.inputSchema;
    expect(defaultSchema.safeParse(undefined).success).toBe(false);
    expect(defaultSnapshot.safeParse(undefined).success).toBe(false);
    expect((defaultSnapshot as { jsonSchema?: unknown }).jsonSchema).not.toHaveProperty("default");

    const keywordSchema = z.string().meta({ type: "number", minLength: 100 });
    const keywordAdapter = new ContractTestAdapter();
    (keywordAdapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...keywordAdapter.actions.write!,
      inputSchema: keywordSchema,
    };
    const keywordRegistry = new AdapterRegistry();
    keywordRegistry.register(keywordAdapter);
    const keywordSnapshot = keywordRegistry.get(keywordAdapter.id)!.actions.write!.inputSchema;
    expect(keywordSchema.safeParse("x").success).toBe(true);
    expect(keywordSnapshot.safeParse("x").success).toBe(true);
    expect(keywordSnapshot.safeParse(1).success).toBe(false);
    expect((keywordSnapshot as { jsonSchema?: unknown }).jsonSchema).toMatchObject({
      type: "string",
    });

    const emitterSchema = z.string();
    (emitterSchema as unknown as {
      _zod: { toJSONSchema?: () => unknown };
    })._zod.toJSONSchema = () => ({ type: "number" });
    const emitterAdapter = new ContractTestAdapter();
    (emitterAdapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...emitterAdapter.actions.write!,
      inputSchema: emitterSchema,
    };
    expect(() => new AdapterRegistry().register(emitterAdapter)).toThrow(/declarative/u);

    const processEmitterSchema = z.string();
    (processEmitterSchema as unknown as {
      _zod: {
        processJSONSchema: (_context: unknown, json: Record<string, unknown>) => void;
      };
    })._zod.processJSONSchema = (_context, json) => {
      json.type = "number";
    };
    const processEmitterAdapter = new ContractTestAdapter();
    (processEmitterAdapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...processEmitterAdapter.actions.write!,
      inputSchema: processEmitterSchema,
    };
    expect(() => new AdapterRegistry().register(processEmitterAdapter)).toThrow(/declarative/u);

    const parentSchema = z.string();
    const childSchema = parentSchema.meta({ description: "child" });
    (parentSchema as unknown as {
      _zod: {
        processJSONSchema: (_context: unknown, json: Record<string, unknown>) => void;
      };
    })._zod.processJSONSchema = (_context, json) => {
      json.type = "number";
    };
    const parentEmitterAdapter = new ContractTestAdapter();
    (parentEmitterAdapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...parentEmitterAdapter.actions.write!,
      inputSchema: childSchema,
    };
    expect(() => new AdapterRegistry().register(parentEmitterAdapter)).toThrow(/declarative/u);

    const statefulShapeSchema = z.object({ value: z.string() }).strict();
    let shapeReads = 0;
    Object.defineProperty(
      (statefulShapeSchema as unknown as { _zod: { def: object } })._zod.def,
      "shape",
      {
        enumerable: true,
        configurable: true,
        get: () => {
          shapeReads += 1;
          return shapeReads === 1 ? { value: z.string() } : { value: z.number() };
        },
      },
    );
    const statefulShapeAdapter = new ContractTestAdapter();
    (statefulShapeAdapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...statefulShapeAdapter.actions.write!,
      inputSchema: statefulShapeSchema,
    };
    expect(() => new AdapterRegistry().register(statefulShapeAdapter)).toThrow(/declarative/u);
    expect(shapeReads).toBe(0);

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
      const literalAdapter = new ContractTestAdapter();
      (literalAdapter.actions as Record<string, AdapterActionDefinition>).write = {
        ...literalAdapter.actions.write!,
        inputSchema: z.literal(value),
      };
      expect(() => new AdapterRegistry().register(literalAdapter)).toThrow(/declarative/u);

      const enumAdapter = new ContractTestAdapter();
      (enumAdapter.actions as Record<string, AdapterActionDefinition>).write = {
        ...enumAdapter.actions.write!,
        inputSchema: z.enum({ INVALID: value }),
      };
      expect(() => new AdapterRegistry().register(enumAdapter)).toThrow(/declarative/u);
    }
  });

  it("bounds schema scalar payloads during registration", () => {
    const oversized = "x".repeat(1_025);
    for (const schema of [
      z.literal(oversized),
      z.object({ [oversized]: z.string() }).strict(),
      z.string().regex(new RegExp(oversized)),
    ]) {
      const adapter = new ContractTestAdapter();
      (adapter.actions as Record<string, AdapterActionDefinition>).write = {
        ...adapter.actions.write!,
        inputSchema: schema,
      };
      expect(() => new AdapterRegistry().register(adapter)).toThrow(/declarative|bounded/u);
    }
  });

  it("fails closed when a declarative schema graph proxy cannot be captured", () => {
    const proxiedShapeSchema = z.object({ value: z.string() }).strict();
    Object.defineProperty(
      (proxiedShapeSchema as unknown as { _zod: { def: object } })._zod.def,
      "shape",
      {
        enumerable: true,
        configurable: true,
        value: new Proxy(
          { value: z.string() },
          {
            ownKeys: () => {
              throw new Error("stateful-shape-proxy");
            },
          },
        ),
      },
    );
    const adapter = new ContractTestAdapter();
    (adapter.actions as Record<string, AdapterActionDefinition>).write = {
      ...adapter.actions.write!,
      inputSchema: proxiedShapeSchema,
    };
    expect(() => new AdapterRegistry().register(adapter)).toThrow(/declarative/u);
  });

  it("rejects extra string-array keys in closed manifest collections", () => {
    const decorations = [
      (values: string[]) => Object.assign(values, { extra: true }),
      (values: string[]) => {
        Object.defineProperty(values, Symbol("extra"), { value: true });
        return values;
      },
    ];
    for (const decorate of decorations) {
      const capabilityAdapter = new ContractTestAdapter();
      (capabilityAdapter.actions as Record<string, AdapterActionDefinition>).write = {
        ...capabilityAdapter.actions.write!,
        requiredCapabilities: decorate(["game.act.write"]),
      };
      expect(() => new AdapterRegistry().register(capabilityAdapter)).toThrow(/string array/u);

      const errorCodeAdapter = new ContractTestAdapter();
      (errorCodeAdapter.actions as Record<string, AdapterActionDefinition>).write = {
        ...errorCodeAdapter.actions.write!,
        adapterErrorCodes: decorate(["DENIED"]),
      };
      expect(() => new AdapterRegistry().register(errorCodeAdapter)).toThrow(/string array/u);
    }
  });

  it("registers a zero-action adapter without a revision provider and enforces serial reads", async () => {
    const adapter = new ReadOnlySerialAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    expect(describeAdapter(registry.get(adapter.id)!)).toMatchObject({
      observation: { concurrency: { kind: "serial" } },
      actions: {},
    });

    const actionSource = new ContractTestAdapter();
    const noRevisionActionAdapter: GameAdapter = {
      id: "no-revision-action",
      displayName: "Action adapter without revision admission",
      observation: actionSource.observation,
      actions: actionSource.actions,
      observe: actionSource.observe.bind(actionSource),
      execute: actionSource.execute.bind(actionSource),
    };
    expect(() => new AdapterRegistry().register(noRevisionActionAdapter)).not.toThrow();
    const revisionRequiredAdapter: GameAdapter = {
      ...noRevisionActionAdapter,
      id: "revision-required-action",
      actions: {
        write: {
          ...actionSource.actions.write!,
          requiresExpectedRevision: true,
        },
      },
    };
    expect(() => new AdapterRegistry().register(revisionRequiredAdapter)).toThrow(
      /revision provider/u,
    );

    const bridge = new GameBridge({
      registry,
      sessions: new SessionManager({ idGenerator: () => "read-only-session" }),
      grantProvider: readOnlyGrantProvider,
    });
    const sessionId = await open(bridge, adapter.id, ["game.observe"]);
    const first = bridge.handle(
      request("read-first", "game.observe", { adapterId: adapter.id }, { sessionId }),
      local,
    );
    await adapter.entered.promise;
    const second = await bridge.handle(
      request("read-second", "game.observe", { adapterId: adapter.id }, { sessionId }),
      local,
    );
    expectError(second, "RESOURCE_CAPACITY");
    expect(second.ok ? undefined : second.error.operationPhase).toBe("pre-dispatch");
    adapter.release.resolve();
    expect(await first).toMatchObject({ ok: true, result: { value: 1 } });
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

  it("rejects malformed runtime grants before session or audit reservation side effects", async () => {
    const baseGrant = {
      allowed: true,
      capabilities: ["game.observe"],
      scope: { kind: "contract-test", resourceId: "contract-world" },
      ttlMs: 1_000,
      totalActionBudget: 1,
      perActionBudgets: { write: 1 },
    };
    const invalidGrants: readonly unknown[] = [
      { ...baseGrant, ttlMs: Number.NaN },
      { ...baseGrant, ttlMs: 1.5 },
      { ...baseGrant, ttlMs: 60 * 60 * 1_000 + 1 },
      { ...baseGrant, unexpected: true },
      { ...baseGrant, scope: { ...baseGrant.scope, unexpected: true } },
      { ...baseGrant, scope: { kind: "other-adapter", resourceId: "contract-world" } },
      { ...baseGrant, scope: { kind: "contract-test", resourceId: "x".repeat(129) } },
      { ...baseGrant, totalActionBudget: 1.5 },
      { ...baseGrant, capabilities: ["x".repeat(129)] },
      { ...baseGrant, perActionBudgets: { unknown_action: 1 } },
      { ...baseGrant, perActionBudgets: { write: 2 } },
    ];

    for (const [index, invalidGrant] of invalidGrants.entries()) {
      const adapter = new ContractTestAdapter();
      const registry = new AdapterRegistry();
      registry.register(adapter);
      const sessions = new SessionManager({ idGenerator: () => `invalid-grant-${index}` });
      const audit = new ReservationCountingAuditSink();
      const grantProvider = {
        grant: () => invalidGrant,
      } as unknown as CapabilityGrantProvider;
      const bridge = new GameBridge({ registry, sessions, auditSink: audit, grantProvider });
      const response = await bridge.handle(
        request(`invalid-grant-${index}`, "session.open", {
          adapterId: adapter.id,
          capabilities: ["game.observe"],
        }),
        local,
      );
      expectError(response, "AUTHORIZATION_DENIED");
      expect(response.ok ? undefined : response.error.operationPhase).toBe("pre-dispatch");
      expect(sessions.size).toBe(0);
      expect(audit.reservations).toBe(0);
    }
  });

  it("captures grant capability array length from one own data descriptor", async () => {
    let liveLengthReads = 0;
    let lengthDescriptorReads = 0;
    const capabilities = new Proxy(["game.observe"], {
      get(target, property, receiver) {
        if (property === "length") {
          liveLengthReads += 1;
          return 65;
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") lengthDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const adapter = new ContractTestAdapter();
    const grantProvider: CapabilityGrantProvider = {
      grant: () => ({
        allowed: true,
        capabilities,
        scope: { kind: "contract-test", resourceId: "contract-world" },
        ttlMs: 1_000,
        totalActionBudget: 1,
        perActionBudgets: { write: 1 },
      }),
    };
    const { bridge, sessions } = contractHarness(adapter, { grantProvider });
    const response = await bridge.handle(
      request("grant-length-snapshot", "session.open", {
        adapterId: adapter.id,
        capabilities: ["game.observe"],
      }),
      local,
    );
    expect(response.ok).toBe(true);
    expect(sessions.size).toBe(1);
    expect(liveLengthReads).toBe(0);
    expect(lengthDescriptorReads).toBe(1);
  });

  it("rechecks committed session admission after an asynchronous grant settles", async () => {
    for (const finalState of ["quiescing", "adapter-faulted"] as const) {
      const adapter = new ContractTestAdapter();
      const grantEntered = deferred();
      const releaseGrant = deferred();
      const baseProvider = testGrantProvider();
      const grantProvider: CapabilityGrantProvider = {
        async grant(grantRequest) {
          grantEntered.resolve();
          await releaseGrant.promise;
          return baseProvider.grant(grantRequest);
        },
      };
      const audit = new ReservationCountingAuditSink();
      const { bridge, sessions } = contractHarness(adapter, { auditSink: audit, grantProvider });
      const opening = bridge.handle(
        request(`deferred-grant-${finalState}`, "session.open", {
          adapterId: adapter.id,
          capabilities: ["game.observe"],
        }),
        local,
      );
      await grantEntered.promise;
      if (finalState === "quiescing") bridge.beginQuiescing();
      else adapter.healthState = "faulted";
      releaseGrant.resolve();

      const response = await opening;
      expectError(response, "RUNTIME_UNAVAILABLE");
      expect(response.ok ? undefined : response.error.operationPhase).toBe("pre-dispatch");
      expect(sessions.size).toBe(0);
      expect(audit.reservations).toBe(0);
    }
  });

  it("rejects commit mode for preview actions before mutation, scheduling, or budget use", async () => {
    const commitPreview = async (
      bridge: GameBridge,
      sessionId: string,
      requestId: string,
    ): Promise<BridgeResponse> =>
      bridge.handle(
        request(
          requestId,
          "game.act",
          { adapterId: "contract-test", gameAction: "preview", input: {} },
          { sessionId, mode: "commit" },
        ),
        local,
      );

    for (const state of ["ready", "stopped", "quiescing"] as const) {
      const adapter = new CommitSignalPreviewAdapter();
      const { bridge, sessions } = contractHarness(adapter, {
        totalBudget: 2,
        perActionBudget: 2,
      });
      const sessionId = await open(bridge, adapter.id, ["game.act.preview"]);
      if (state === "stopped") await bridge.createLocalControlPlane().stopSafety();
      if (state === "quiescing") bridge.beginQuiescing();
      const budgetBefore = sessions.find(sessionId)!.actionBudgetRemaining;
      const response = await commitPreview(bridge, sessionId, `preview-commit-${state}`);
      expectError(response, "ACTION_NOT_ALLOWED");
      expect(response.ok ? undefined : response.error.operationPhase).toBe("pre-dispatch");
      expect(adapter.previewCommitMutations).toBe(0);
      expect(sessions.find(sessionId)!.actionBudgetRemaining).toBe(budgetBefore);
    }

    const scheduledAdapter = new CommitSignalPreviewAdapter("wait");
    const scheduledHarness = contractHarness(scheduledAdapter, {
      totalBudget: 2,
      perActionBudget: 2,
    });
    const scheduledSession = await open(scheduledHarness.bridge, scheduledAdapter.id, [
      "game.act.preview",
      "game.act.write",
    ]);
    const write = scheduledHarness.bridge.handle(
      writeRequest("occupy-write-scheduler", scheduledSession),
      local,
    );
    await scheduledAdapter.entered.promise;
    const budgetBeforePreview = scheduledHarness.sessions.find(scheduledSession)!
      .actionBudgetRemaining;
    const preview = await commitPreview(
      scheduledHarness.bridge,
      scheduledSession,
      "preview-commit-during-write",
    );
    expectError(preview, "ACTION_NOT_ALLOWED");
    expect(scheduledAdapter.previewCommitMutations).toBe(0);
    expect(scheduledHarness.sessions.find(scheduledSession)!.actionBudgetRemaining).toBe(
      budgetBeforePreview,
    );
    const legalDryRunPreview = await scheduledHarness.bridge.handle(
      request(
        "preview-dry-run-during-write",
        "game.act",
        { adapterId: scheduledAdapter.id, gameAction: "preview", input: {} },
        { sessionId: scheduledSession, mode: "dry-run" },
      ),
      local,
    );
    expect(legalDryRunPreview).toMatchObject({
      ok: true,
      result: { applied: false, stateRevision: 0 },
    });
    expect(scheduledAdapter.previewCommitMutations).toBe(0);
    expect(scheduledHarness.sessions.find(scheduledSession)!.actionBudgetRemaining).toBe(
      budgetBeforePreview,
    );
    scheduledAdapter.release.resolve();
    expect(await write).toMatchObject({ ok: true });
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

  it("rolls back undispatched reservations and charges worker-side rejections once", async () => {
    const unavailable = new ContractTestAdapter("pre-dispatch-unavailable");
    const unavailableHarness = contractHarness(unavailable, {
      totalBudget: 1,
      perActionBudget: 1,
    });
    const unavailableSession = await open(
      unavailableHarness.bridge,
      unavailable.id,
      ["game.act.write"],
    );
    const unavailableRequest = writeRequest("runtime-not-started", unavailableSession);
    const unavailableResponse = await unavailableHarness.bridge.handle(
      unavailableRequest,
      local,
    );
    expectError(unavailableResponse, "RUNTIME_UNAVAILABLE");
    expect(unavailableResponse.ok ? undefined : unavailableResponse.error.operationPhase).toBe(
      "pre-dispatch",
    );
    expect(unavailableHarness.sessions.find(unavailableSession)).toMatchObject({
      actionBudgetRemaining: 1,
    });
    expect(await unavailableHarness.bridge.handle(unavailableRequest, local)).toEqual(
      unavailableResponse,
    );
    expect(unavailable.entries).toBe(1);

    const revisionRejected = new ContractTestAdapter("revision-reject");
    const rejectedHarness = contractHarness(revisionRejected, {
      totalBudget: 1,
      perActionBudget: 1,
    });
    const rejectedSession = await open(
      rejectedHarness.bridge,
      revisionRejected.id,
      ["game.act.write"],
    );
    const rejectedRequest = writeRequest("worker-revision-conflict", rejectedSession);
    const rejectedResponse = await rejectedHarness.bridge.handle(rejectedRequest, local);
    expectError(rejectedResponse, "REVISION_CONFLICT");
    expect(rejectedResponse.ok ? undefined : rejectedResponse.error.operationPhase).toBe(
      "adapter-rejected",
    );
    expect(rejectedHarness.sessions.find(rejectedSession)).toMatchObject({
      actionBudgetRemaining: 0,
    });
    expect(await rejectedHarness.bridge.handle(rejectedRequest, local)).toEqual(
      rejectedResponse,
    );
    expect(revisionRejected.entries).toBe(1);
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

  it("maps malformed adapter health to one fixed faulted snapshot before side effects", async () => {
    for (const [index, rawHealth] of ["broken", Promise.resolve("ready")].entries()) {
      const adapter = new RawHealthAdapter();
      const { bridge, sessions } = contractHarness(adapter);
      const sessionId = await open(bridge, adapter.id, ["game.act.write"]);
      adapter.rawHealth = rawHealth;

      const health = bridge.getHealthStatus();
      expect(health).toMatchObject({
        runtime: { status: "faulted" },
        adapter: { status: "faulted", registeredAdapters: 1 },
        audit: { status: "ready" },
      });
      expect(operatorHealthStatusSchema.safeParse(health).success).toBe(true);
      expect(JSON.stringify(health)).not.toContain("Bearer-");

      expectError(
        await bridge.handle(
          request(`health-open-${index}`, "session.open", {
            adapterId: adapter.id,
            capabilities: ["game.observe"],
          }),
          local,
        ),
        "RUNTIME_UNAVAILABLE",
      );
      expectError(
        await bridge.handle(writeRequest(`health-write-${index}`, sessionId), local),
        "RUNTIME_UNAVAILABLE",
      );
      expect(sessions.size).toBe(1);
      expect(adapter.entries).toBe(0);
    }

    const throwing = new RawHealthAdapter();
    const throwingHarness = contractHarness(throwing);
    const sessionId = await open(throwingHarness.bridge, throwing.id, ["game.act.write"]);
    throwing.throwHealth = true;
    expect(throwingHarness.bridge.getHealthStatus()).toMatchObject({
      runtime: { status: "faulted" },
      adapter: { status: "faulted" },
    });
    expectError(
      await throwingHarness.bridge.handle(writeRequest("throwing-health-write", sessionId), local),
      "RUNTIME_UNAVAILABLE",
    );
    expect(throwing.entries).toBe(0);
  });

  it("maps malformed audit health to a legal corrupt snapshot without secondary throws", async () => {
    let accessorReads = 0;
    const accessorHealth = { outstandingWrites: 0 } as Record<string, unknown>;
    Object.defineProperty(accessorHealth, "status", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "ready";
      },
    });
    const malformedHealthValues: readonly unknown[] = [
      { status: "broken", outstandingWrites: 0 },
      { status: "ready", outstandingWrites: Number.NaN },
      { status: "ready", outstandingWrites: -1 },
      Promise.resolve({ status: "ready", outstandingWrites: 0 }),
      { status: "ready", outstandingWrites: 0, then: () => undefined },
      accessorHealth,
    ];

    for (const [index, rawHealth] of malformedHealthValues.entries()) {
      const audit = new RawHealthAuditSink();
      const adapter = new ContractTestAdapter();
      const { bridge, sessions } = contractHarness(adapter, { auditSink: audit });
      const sessionId = await open(bridge, adapter.id, ["game.act.write"]);
      audit.rawHealth = rawHealth;

      const health = bridge.getHealthStatus();
      expect(health).toMatchObject({
        runtime: { status: "ready" },
        adapter: { status: "ready" },
        audit: { status: "corrupt" },
      });
      expect(operatorHealthStatusSchema.safeParse(health).success).toBe(true);
      expectError(
        await bridge.handle(writeRequest(`malformed-audit-${index}`, sessionId), local),
        "RUNTIME_UNAVAILABLE",
      );
      expect(sessions.size).toBe(1);
      expect(adapter.entries).toBe(0);
    }
    expect(accessorReads).toBe(0);

    const throwingAudit = new RawHealthAuditSink();
    const throwingAdapter = new ContractTestAdapter();
    const throwingHarness = contractHarness(throwingAdapter, { auditSink: throwingAudit });
    const sessionId = await open(
      throwingHarness.bridge,
      throwingAdapter.id,
      ["game.observe", "game.act.write"],
    );
    throwingAudit.throwHealth = true;
    expect(throwingHarness.bridge.getHealthStatus()).toMatchObject({
      audit: { status: "corrupt" },
    });
    expectError(
      await throwingHarness.bridge.handle(
        writeRequest("throwing-audit-health", sessionId),
        local,
      ),
      "RUNTIME_UNAVAILABLE",
    );
    expect(JSON.stringify(throwingHarness.bridge.getHealthStatus())).not.toContain(
      "Bearer-audit-health-secret",
    );

    throwingAudit.throwWrite = true;
    expect(
      await throwingHarness.bridge.handle(
        request(
          "audit-rejection-health-throw",
          "game.observe",
          { adapterId: throwingAdapter.id },
          { sessionId },
        ),
        local,
      ),
    ).toMatchObject({ ok: true, result: { stateRevision: 0 } });
    expect(throwingHarness.bridge.getHealthStatus()).toMatchObject({
      audit: { status: "corrupt" },
    });
  });

  it("blocks new state-change admission while quiescing and drains write audit completion", async () => {
    const adapter = new ContractTestAdapter("wait");
    const audit = new GatedStateChangeAuditSink();
    const { bridge } = contractHarness(adapter, { auditSink: audit });
    const sessionId = await open(bridge, adapter.id, ["game.observe", "game.act.write"]);
    const write = bridge.handle(writeRequest("drained-write", sessionId), local);
    await adapter.entered.promise;

    bridge.beginQuiescing();
    const refusedOpen = await bridge.handle(
      request("open-during-quiesce", "session.open", {
        adapterId: adapter.id,
        capabilities: ["game.observe"],
      }),
      local,
    );
    expectError(refusedOpen, "RUNTIME_UNAVAILABLE");
    expect(refusedOpen.ok ? undefined : refusedOpen.error.operationPhase).toBe("pre-dispatch");
    expect(
      await bridge.handle(
        request("observe-during-quiesce", "game.observe", { adapterId: adapter.id }, { sessionId }),
        local,
      ),
    ).toMatchObject({ ok: true, result: { stateRevision: 0 } });

    const idle = bridge.waitForMutationsIdle();
    let idleSettled = false;
    void idle.then(() => {
      idleSettled = true;
    });
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    adapter.release.resolve();
    await audit.writeAuditEntered.promise;
    await idle;
    expect(idleSettled).toBe(true);
    const auditIdle = bridge.createLocalControlPlane().waitForAuditIdle();
    let auditIdleSettled = false;
    void auditIdle.then(() => {
      auditIdleSettled = true;
    });
    await Promise.resolve();
    expect(auditIdleSettled).toBe(false);
    audit.releaseWriteAudit.resolve();
    expect(await write).toMatchObject({ ok: true });
    await auditIdle;
    expect(auditIdleSettled).toBe(true);
    expect(
      await bridge.handle(
        request("close-during-quiesce", "session.close", {}, { sessionId }),
        local,
      ),
    ).toMatchObject({ ok: true, result: { closed: true } });
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
