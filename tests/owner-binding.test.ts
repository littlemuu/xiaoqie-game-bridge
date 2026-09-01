import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AdapterRegistry,
  GameBridge,
  MemoryAuditSink,
  MockGameAdapter,
  SafetyLatch,
  SessionManager,
  deriveSessionOwnerKey,
  sessionCallerTag,
  type AdapterActionDefinition,
  type BridgeMode,
  type BridgeResponse,
  type GameAdapter,
  type RequestContext,
  type RequestEnvelope,
  type SessionAuthorizationRequest,
  type SessionAuthorizer,
} from "../src/index.js";

const TEST_CALLER_TAG_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);

const REMOTE_A = Object.freeze({
  transport: "remote",
  principal: Object.freeze({ subject: "reviewer-a", method: "test-token" }),
} satisfies RequestContext);
const REMOTE_B = Object.freeze({
  transport: "remote",
  principal: Object.freeze({ subject: "reviewer-b", method: "test-token" }),
} satisfies RequestContext);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

class AllowTrustedRemoteAuthorizer implements SessionAuthorizer {
  calls = 0;

  authorize(request: SessionAuthorizationRequest): boolean {
    this.calls += 1;
    return request.context.transport === "remote";
  }
}

const trustedRemoteGrantProvider = {
  grant(request: {
    adapter: GameAdapter;
    context: RequestContext;
    requestedCapabilities: readonly string[];
    requestedTtlMs?: number;
  }) {
    if (request.context.transport !== "remote" || request.adapter.id !== "mock-world") {
      return { allowed: false as const };
    }
    return {
      allowed: true as const,
      capabilities: [...new Set(request.requestedCapabilities)].sort(),
      scope: { kind: "test-resource" as const, resourceId: "owner-bound-world" },
      ttlMs: request.requestedTtlMs ?? 15 * 60 * 1_000,
      totalActionBudget: 64,
      perActionBudgets: { move: 64, place_block: 64 },
    };
  },
};

interface Harness {
  audit: MemoryAuditSink;
  authorizer: SessionAuthorizer;
  bridge: GameBridge;
  registry: AdapterRegistry;
  sessions: SessionManager;
}

function createHarness(options: {
  adapter?: GameAdapter;
  authorizer?: SessionAuthorizer;
  callerTagKey?: Uint8Array;
  maxRequestsPerSession?: number;
} = {}): Harness {
  const registry = new AdapterRegistry();
  registry.register(options.adapter ?? new MockGameAdapter());
  const audit = new MemoryAuditSink();
  const authorizer = options.authorizer ?? new AllowTrustedRemoteAuthorizer();
  const sessions = new SessionManager({
    idGenerator: () => "owner-bound-session",
    maxRequestsPerSession: options.maxRequestsPerSession ?? 32,
  });
  return {
    audit,
    authorizer,
    bridge: new GameBridge({
      registry,
      auditSink: audit,
      authorizer,
      grantProvider: trustedRemoteGrantProvider,
      callerTagKey: options.callerTagKey ?? TEST_CALLER_TAG_KEY,
      sessions,
      safetyLatch: new SafetyLatch(),
    }),
    registry,
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

function openRequest(requestId: string, mode: "dry-run" | "commit" = "commit") {
  return envelope(
    requestId,
    "session.open",
    {
      adapterId: "mock-world",
      capabilities: ["game.observe", "game.act.move", "safety.stop"],
    },
    { mode },
  );
}

async function openRemote(
  harness: Harness,
  context: RequestContext = REMOTE_A,
): Promise<string> {
  const response = await harness.bridge.handle(openRequest("owner-open"), context);
  expect(response.ok).toBe(true);
  return (response as { result: { sessionId: string } }).result.sessionId;
}

function observeRequest(requestId: string, sessionId: string): RequestEnvelope {
  return envelope(
    requestId,
    "game.observe",
    { adapterId: "mock-world" },
    { sessionId },
  );
}

function moveRequest(
  requestId: string,
  sessionId: string,
  mode: "dry-run" | "commit" = "commit",
): RequestEnvelope {
  return envelope(
    requestId,
    "game.act",
    {
      adapterId: "mock-world",
      gameAction: "move",
      input: { dx: 1, dy: 0, dz: 0 },
      expectedRevision: 0,
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

describe("session owner binding", () => {
  it("keeps the full remote lifecycle and idempotency available to the same owner", async () => {
    const harness = createHarness();
    const dryOpen = await harness.bridge.handle(openRequest("dry-open", "dry-run"), REMOTE_A);
    expect(dryOpen.ok && dryOpen.result).toMatchObject({ wouldOpen: true });
    expect(harness.sessions.size).toBe(0);

    const sessionId = await openRemote(harness);
    expect((await harness.bridge.handle(observeRequest("observe", sessionId), REMOTE_A)).ok)
      .toBe(true);
    const preview = await harness.bridge.handle(moveRequest("preview", sessionId, "dry-run"), REMOTE_A);
    expect(preview.ok && preview.result).toMatchObject({ applied: false });
    const move = moveRequest("move", sessionId);
    const first = await harness.bridge.handle(move, REMOTE_A);
    const duplicate = await harness.bridge.handle(move, REMOTE_A);
    expect(first.ok).toBe(true);
    expect(duplicate).toEqual(first);
    expect(harness.audit.events.at(-1)?.idempotencyHit).toBe(true);

    const close = await harness.bridge.handle(
      envelope("close", "session.close", {}, { sessionId }),
      REMOTE_A,
    );
    expect(close.ok).toBe(true);
  });

  it("denies another subject before cache, capabilities, adapter, safety, or close", async () => {
    const harness = createHarness({ maxRequestsPerSession: 1 });
    const sessionId = await openRemote(harness);
    const completed = await harness.bridge.handle(moveRequest("shared-id", sessionId), REMOTE_A);
    expect(completed.ok).toBe(true);
    const session = harness.sessions.find(sessionId)!;
    const cacheSize = session.requests.size;
    const safetyBefore = harness.bridge.createLocalControlPlane().getSafetyStatus();

    for (const request of [
      observeRequest("b-observe", sessionId),
      moveRequest("b-act", sessionId),
      envelope("b-stop", "safety.stop", {}, { sessionId }),
      envelope("b-close", "session.close", {}, { sessionId }),
      moveRequest("shared-id", sessionId),
    ]) {
      expectError(await harness.bridge.handle(request, REMOTE_B), "AUTHORIZATION_DENIED");
    }

    expect(session.requests.size).toBe(cacheSize);
    expect(session.closedAt).toBeUndefined();
    expect(harness.bridge.createLocalControlPlane().getSafetyStatus()).toEqual(safetyBefore);
    const state = await harness.registry.get("mock-world")!.observe();
    expect(state).toMatchObject({ player: { x: 1 } });
    const callerTags = harness.audit.events
      .map((event) => event.callerTag)
      .filter((tag): tag is string => tag !== undefined);
    expect(new Set(callerTags).size).toBe(2);
    expect(callerTags.every((tag) => /^[a-f0-9]{12}$/.test(tag))).toBe(true);
  });

  it("binds both remote method and subject and never treats omitted context as local", async () => {
    const authorizer = new AllowTrustedRemoteAuthorizer();
    const harness = createHarness({ authorizer });
    const sessionId = await openRemote(harness);
    const variants: unknown[] = [
      undefined,
      { transport: "local" },
      { transport: "remote", principal: { ...REMOTE_A.principal, subject: "reviewer-c" } },
      { transport: "remote", principal: { ...REMOTE_A.principal, method: "mTLS" } },
    ];
    for (const context of variants) {
      expectError(
        await harness.bridge.handle(observeRequest("owner-variant", sessionId), context),
        "AUTHORIZATION_DENIED",
      );
    }
    expect(authorizer.calls).toBe(1);
    expect(harness.sessions.find(sessionId)?.requests.size).toBe(0);
  });

  it("rejects malformed or extended contexts before the authorizer and adapter", async () => {
    const authorizer = new AllowTrustedRemoteAuthorizer();
    const harness = createHarness({ authorizer });
    const invalidContexts: unknown[] = [
      undefined,
      { transport: "remote" },
      { transport: "remote", principal: { subject: "", method: "token" } },
      { transport: "remote", principal: { subject: "a".repeat(129), method: "token" } },
      { transport: "remote", principal: { subject: "a", method: "" } },
      { transport: "remote", principal: { subject: "a", method: "token", extra: true } },
      { transport: "remote", principal: { subject: "a", method: "token" }, extra: true },
      { transport: "local", principal: { subject: "forged", method: "token" } },
      { transport: "local", extra: true },
      Object.assign({ transport: "local" }, { [Symbol("extra")]: true }),
      Object.assign(Object.create({ inherited: true }), { transport: "local" }),
    ];
    for (const [index, context] of invalidContexts.entries()) {
      expectError(
        await harness.bridge.handle({ ...openRequest(`invalid-${index}`) }, context),
        "AUTHORIZATION_DENIED",
      );
    }
    expect(authorizer.calls).toBe(0);
    expect(harness.sessions.size).toBe(0);
    expect((await harness.bridge.handle(envelope("describe", "bridge.describe", {}))).ok)
      .toBe(true);
  });

  it("fail-closes stateful Proxy value changes from one descriptor snapshot", async () => {
    const authorizer = new AllowTrustedRemoteAuthorizer();
    const replacements = [
      { subject: "", method: "" },
      { subject: undefined, method: undefined },
    ];

    for (const [index, replacement] of replacements.entries()) {
      const harness = createHarness({ authorizer });
      const validPrincipal = { subject: "masked-subject", method: "masked-method" };
      let principalReads = 0;
      const changingContext = new Proxy(
        { transport: "remote", principal: replacement },
        {
          get(target, property, receiver) {
            if (property === "principal" && principalReads++ < 3) {
              return validPrincipal;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const registryGet = vi.spyOn(harness.registry, "get");

      const response = await harness.bridge.handle(
        openRequest(`proxy-change-${index}`),
        changingContext,
      );

      expectError(response, "AUTHORIZATION_DENIED");
      expect(authorizer.calls).toBe(0);
      expect(harness.sessions.size).toBe(0);
      expect(registryGet).not.toHaveBeenCalled();
    }
  });

  it("uses an immutable nested context snapshot across an asynchronous authorizer", async () => {
    const gate = deferred<void>();
    let receivedContext: RequestContext | undefined;
    const authorizer: SessionAuthorizer = {
      authorize: async (request) => {
        receivedContext = request.context;
        await gate.promise;
        return true;
      },
    };
    const harness = createHarness({ authorizer });
    const mutableContext = {
      transport: "remote",
      principal: { subject: "original-subject", method: "original-method" },
    };
    const opening = harness.bridge.handle(openRequest("deferred-open"), mutableContext);
    mutableContext.transport = "local";
    mutableContext.principal.subject = "mutated-subject";
    mutableContext.principal.method = "mutated-method";
    gate.resolve();

    const opened = await opening;
    expect(opened.ok).toBe(true);
    expect(Object.isFrozen(receivedContext)).toBe(true);
    expect(receivedContext?.transport).toBe("remote");
    if (receivedContext?.transport === "remote") {
      expect(Object.isFrozen(receivedContext.principal)).toBe(true);
      expect(receivedContext.principal).toEqual({
        subject: "original-subject",
        method: "original-method",
      });
    }
    const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
    expect(
      (
        await harness.bridge.handle(observeRequest("original", sessionId), {
          transport: "remote",
          principal: { subject: "original-subject", method: "original-method" },
        })
      ).ok,
    ).toBe(true);
    expectError(
      await harness.bridge.handle(observeRequest("mutated", sessionId), mutableContext),
      "AUTHORIZATION_DENIED",
    );
  });

  it("does not expose owner material or caller credentials in responses or audit", async () => {
    const subject = "Bearer-owner-subject-secret";
    const method = "password-owner-method-secret";
    const context = {
      transport: "remote",
      principal: { subject, method },
    } as const;
    const harness = createHarness();
    const opened = await harness.bridge.handle(openRequest("secret-open"), context);
    expect(opened.ok).toBe(true);
    const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
    const session = harness.sessions.find(sessionId)!;
    const observed = await harness.bridge.handle(observeRequest("secret-observe", sessionId), context);
    const serialized = JSON.stringify({ opened, observed, audit: harness.audit.events });

    expect(session.ownerKey).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.getOwnPropertyDescriptor(session, "ownerKey")).toMatchObject({
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(JSON.stringify(session)).not.toContain(session.ownerKey);
    expect(serialized).not.toContain(session.ownerKey);
    expect(serialized).not.toContain(subject);
    expect(serialized).not.toContain(method);
    const tags = harness.audit.events.map((event) => event.callerTag).filter(Boolean);
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags).size).toBe(1);
    expect(tags[0]).toMatch(/^[a-f0-9]{12}$/);
    harness.audit.write({
      timestamp: "2026-08-30T00:00:00.000Z",
      action: "test",
      mode: "commit",
      decision: "deny",
      safetyStopped: false,
      idempotencyHit: false,
      metadata: { ownerKey: session.ownerKey, principal: { subject, method } },
    });
    expect(JSON.stringify(harness.audit.events.at(-1))).not.toContain(session.ownerKey);
    expect(JSON.stringify(harness.audit.events.at(-1))).not.toContain(subject);
  });

  it("prevents low-entropy principal enumeration without the caller-tag secret", async () => {
    const actualSubject = "alice@example.test";
    const method = "password";
    const context = {
      transport: "remote",
      principal: { subject: actualSubject, method },
    } as const;
    const harness = createHarness();
    await harness.bridge.handle(openRequest("enumeration-open"), context);
    const observedTag = harness.audit.events.at(-1)?.callerTag;
    expect(observedTag).toMatch(/^[a-f0-9]{12}$/);

    const attackerGuessKey = Uint8Array.from(
      { length: 32 },
      (_, index) => 255 - index,
    );
    const candidates = [
      "admin@example.test",
      "alice@example.test",
      "bob@example.test",
      "guest@example.test",
    ];
    const guessedTags = candidates.map((subject) =>
      sessionCallerTag(
        deriveSessionOwnerKey({
          transport: "remote",
          principal: { subject, method },
        }),
        attackerGuessKey,
      ),
    );
    expect(guessedTags).not.toContain(observedTag);

    const actualOwnerKey = deriveSessionOwnerKey(context);
    expect(sessionCallerTag(actualOwnerKey, TEST_CALLER_TAG_KEY)).toBe(observedTag);
    const serializedAudit = JSON.stringify(harness.audit.events);
    expect(serializedAudit).not.toContain(Buffer.from(TEST_CALLER_TAG_KEY).toString("hex"));
    expect(serializedAudit).not.toContain(Buffer.from(TEST_CALLER_TAG_KEY).toString("base64"));
  });
});

const gatedSchema = z.object({ wait: z.boolean() }).strict();
const ownerObservationSchema = z.object({ entries: z.number().int().nonnegative() }).strict();
const ownerResultSchema = z.object({ applied: z.boolean() }).strict();

class OwnerGatedAdapter implements GameAdapter {
  readonly id = "mock-world";
  readonly displayName = "Owner binding gated adapter";
  readonly observation = {
    description: "Observe the owner-binding test entry count.",
    outputSchema: ownerObservationSchema,
    effectKind: "read" as const,
    concurrency: "parallel" as const,
    requiredCapabilities: ["game.observe"],
    maxResultBytes: 1_024,
  };
  readonly actions: Readonly<Record<string, AdapterActionDefinition>> = {
    move: {
      description: "Test-only owner binding gate.",
      inputSchema: gatedSchema,
      outputSchema: ownerResultSchema,
      effectKind: "write",
      dryRunSemantics: "exact",
      requiredCapabilities: ["game.act.move"],
      maxResultBytes: 1_024,
      writeConcurrency: { kind: "resource-serial", resourceKey: "owner-world" },
      adapterErrorCodes: [],
      requiresExpectedRevision: false,
      reconciliation: "unsupported",
    },
  };
  entries = 0;
  readonly entered = deferred<void>();
  readonly release = deferred<void>();

  async observe(): Promise<unknown> {
    return { entries: this.entries };
  }

  async getStateRevision(): Promise<number> {
    return this.entries;
  }

  async execute(_action: string, input: unknown, mode: BridgeMode): Promise<unknown> {
    const parsed = gatedSchema.parse(input);
    if (mode === "dry-run") {
      return { applied: false };
    }
    this.entries += 1;
    this.entered.resolve();
    if (parsed.wait) {
      await this.release.promise;
    }
    return { applied: true };
  }
}

describe("session owner in-flight isolation", () => {
  it("denies a different owner with the same in-flight request ID without joining it", async () => {
    const adapter = new OwnerGatedAdapter();
    const harness = createHarness({ adapter });
    const sessionId = await openRemote(harness);
    const request = envelope(
      "in-flight-shared",
      "game.act",
      { adapterId: "mock-world", gameAction: "move", input: { wait: true } },
      { sessionId },
    );
    const ownerRequest = harness.bridge.handle(request, REMOTE_A);
    await adapter.entered.promise;

    const intruderResponse = await harness.bridge.handle(request, REMOTE_B);
    expectError(intruderResponse, "AUTHORIZATION_DENIED");
    expect(adapter.entries).toBe(1);
    expect(harness.sessions.find(sessionId)?.requests.get(request.requestId)?.state)
      .toBe("in-flight");

    adapter.release.resolve();
    expect((await ownerRequest).ok).toBe(true);
  });
});
