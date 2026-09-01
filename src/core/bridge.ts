import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  AdapterExecutionError,
  AdapterRuntimeError,
  describeAdapter,
  type AdapterActionDefinition,
} from "./adapter.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { canonicalJson } from "./canonical-json.js";
import {
  type AuditEvent,
  type AuditSink,
  type AuditWriteReservation,
  MemoryAuditSink,
  redactSensitive,
  safeIdentifierTag,
  writeAudit,
} from "./audit.js";
import { PolicyEngine } from "./policy.js";
import {
  type CapabilityGrantProvider,
  TrustedMockGrantProvider,
} from "./grant.js";
import type {
  AdapterHealthStatus,
  AuditHealthStatus,
  BridgeHealthStatus,
  RuntimeHealthStatus,
} from "./health.js";
import {
  type BridgeResponse,
  type ErrorCode,
  type RequestEnvelope,
  errorResponse,
  isKnownBridgeAction,
  knownBridgeActions,
  PROTOCOL_VERSION,
  requestEnvelopeSchema,
  successResponse,
} from "./protocol.js";
import {
  type SafetyResumeResult,
  type SafetyStatus,
  SafetyLatch,
} from "./safety-latch.js";
import {
  CALLER_TAG_KEY_BYTES,
  deriveSessionOwnerKey,
  sessionCallerTag,
  snapshotRequestContext,
  type RequestContext,
  type SessionOwnerKey,
} from "./request-context.js";
import {
  MAX_SESSION_TTL_MS,
  type Session,
  SessionCapacityError,
  SessionManager,
  reserveSessionActionBudget,
} from "./session.js";
import { ResourceWriteScheduler } from "./write-scheduler.js";

export type { RequestContext } from "./request-context.js";

const emptyParamsSchema = z.object({}).strict();
const sessionOpenParamsSchema = z
  .object({
    adapterId: z.string().min(1).max(128),
    capabilities: z.array(z.string().min(1).max(128)).max(64),
    ttlMs: z.number().int().positive().max(MAX_SESSION_TTL_MS).optional(),
  })
  .strict();
const adapterParamsSchema = z
  .object({ adapterId: z.string().min(1).max(128) })
  .strict();
const gameActParamsSchema = z
  .object({
    adapterId: z.string().min(1).max(128),
    gameAction: z.string().min(1).max(128),
    input: z.unknown(),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

export interface SessionAuthorizationRequest {
  adapterId: string;
  capabilities: readonly string[];
  context: RequestContext;
}

export interface SessionAuthorizer {
  authorize(request: SessionAuthorizationRequest): boolean | Promise<boolean>;
}

export class OfflineLocalAuthorizer implements SessionAuthorizer {
  authorize(request: SessionAuthorizationRequest): boolean {
    return request.context.transport === "local";
  }
}

export interface BridgeOptions {
  registry: AdapterRegistry;
  sessions?: SessionManager;
  policy?: PolicyEngine;
  safetyLatch?: SafetyLatch;
  auditSink?: AuditSink;
  authorizer?: SessionAuthorizer;
  grantProvider?: CapabilityGrantProvider;
  writeScheduler?: ResourceWriteScheduler;
  clock?: () => number;
  callerTagKey?: Uint8Array;
}

export interface BridgeLocalControlPlane {
  stopSafety(): Promise<SafetyStatus & { stopped: true; alreadyStopped: boolean }>;
  getSafetyStatus(): SafetyStatus;
  getHealthStatus(): BridgeHealthStatus;
  getOutstandingAuditWrites(): number;
  waitForAuditIdle(): Promise<void>;
  resumeSafety(
    generation: number,
    options?: { signal?: AbortSignal },
  ): Promise<SafetyResumeResult>;
}

function abortable<T>(
  promise: Promise<T>,
  ...signals: Array<AbortSignal | undefined>
): Promise<T> {
  const activeSignals = signals.filter((signal) => signal !== undefined);
  if (activeSignals.length === 0) return promise;
  if (activeSignals.some((signal) => signal.aborted)) {
    return Promise.reject(new Error("local-control-aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new Error("local-control-aborted"));
    };
    const cleanup = () => {
      for (const signal of activeSignals) signal.removeEventListener("abort", abort);
    };
    for (const signal of activeSignals) signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function safeInvalidRequest(raw: unknown): RequestEnvelope {
  const object = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const requestId =
    typeof object.requestId === "string" && object.requestId.length <= 128
      ? object.requestId
      : "invalid";
  const action =
    typeof object.action === "string" && object.action.length <= 128
      ? object.action
      : "invalid";
  const sessionId =
    typeof object.sessionId === "string" && object.sessionId.length <= 128
      ? object.sessionId
      : undefined;
  const mode = object.mode === "commit" ? "commit" : "dry-run";
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    action,
    params: {},
    mode,
  };
}

type AdapterOutputValidation =
  | { valid: true; result: unknown }
  | { valid: false; code: "ADAPTER_OUTPUT_INVALID" | "ADAPTER_RESULT_TOO_LARGE" };

function validateAdapterOutput(
  schema: z.ZodType<unknown>,
  maxResultBytes: number,
  candidate: unknown,
): AdapterOutputValidation {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) return { valid: false, code: "ADAPTER_OUTPUT_INVALID" };
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalJson(parsed.data), "utf8");
  } catch {
    return { valid: false, code: "ADAPTER_OUTPUT_INVALID" };
  }
  if (bytes > maxResultBytes) {
    return { valid: false, code: "ADAPTER_RESULT_TOO_LARGE" };
  }
  return { valid: true, result: parsed.data };
}

const PROCESS_CALLER_TAG_KEY = randomBytes(CALLER_TAG_KEY_BYTES);

export class GameBridge {
  readonly #registry: AdapterRegistry;
  readonly #sessions: SessionManager;
  readonly #policy: PolicyEngine;
  readonly #safety: SafetyLatch;
  readonly #audit: AuditSink;
  readonly #authorizer: SessionAuthorizer;
  readonly #grantProvider: CapabilityGrantProvider;
  readonly #writeScheduler: ResourceWriteScheduler;
  readonly #clock: () => number;
  readonly #callerTagKey: Buffer;
  readonly #auditWrites = new Set<Promise<void>>();
  #runtimeHealth: RuntimeHealthStatus = "ready";
  #observedAuditHealth: AuditHealthStatus = "ready";
  #localResumePending = false;
  #localResumeInvalidation = 0;
  #localResumeController: AbortController | undefined;
  #localStopsPending = 0;

  constructor(options: BridgeOptions) {
    this.#registry = options.registry;
    this.#sessions = options.sessions ?? new SessionManager();
    this.#policy = options.policy ?? new PolicyEngine();
    this.#safety = options.safetyLatch ?? new SafetyLatch();
    this.#audit = options.auditSink ?? new MemoryAuditSink();
    this.#authorizer = options.authorizer ?? new OfflineLocalAuthorizer();
    this.#grantProvider = options.grantProvider ?? new TrustedMockGrantProvider();
    this.#writeScheduler = options.writeScheduler ?? new ResourceWriteScheduler();
    this.#clock = options.clock ?? Date.now;
    const callerTagKey = options.callerTagKey ?? PROCESS_CALLER_TAG_KEY;
    if (!(callerTagKey instanceof Uint8Array) || callerTagKey.byteLength !== CALLER_TAG_KEY_BYTES) {
      throw new RangeError("callerTagKey must contain exactly 32 bytes.");
    }
    this.#callerTagKey = Buffer.from(callerTagKey);
  }

  beginQuiescing(): void {
    if (this.#runtimeHealth !== "faulted") this.#runtimeHealth = "quiescing";
  }

  getHealthStatus(): BridgeHealthStatus {
    const adapters = this.#registry.list();
    const adapterStatuses = adapters.map(
      (adapter): AdapterHealthStatus => adapter.health?.() ?? "ready",
    );
    const adapterStatus: AdapterHealthStatus = adapterStatuses.includes("faulted")
      ? "faulted"
      : adapterStatuses.length === 0 || adapterStatuses.includes("unavailable")
        ? "unavailable"
        : "ready";
    const sinkHealth = this.#audit.health?.();
    const sinkAuditStatus = sinkHealth?.status ?? "ready";
    const auditStatus =
      sinkAuditStatus === "ready" ? this.#observedAuditHealth : sinkAuditStatus;
    const runtimeStatus: RuntimeHealthStatus =
      this.#runtimeHealth === "ready" && adapterStatus === "faulted"
        ? "faulted"
        : this.#runtimeHealth === "ready" && adapterStatus === "unavailable"
          ? "degraded"
          : this.#runtimeHealth;
    return Object.freeze({
      runtime: Object.freeze({ status: runtimeStatus }),
      adapter: Object.freeze({ status: adapterStatus, registeredAdapters: adapters.length }),
      audit: Object.freeze({
        status: auditStatus,
        outstandingWrites: sinkHealth?.outstandingWrites ?? this.#auditWrites.size,
      }),
      safety: Object.freeze({ ...this.#safety.status() }),
    });
  }

  createLocalControlPlane(): BridgeLocalControlPlane {
    return Object.freeze({
      stopSafety: async () => {
        this.#localStopsPending += 1;
        try {
          const result = this.#stopSafetyLatch();
          await this.#recordLocalSafety("safety.stop.local", "allow", {
            alreadyStopped: result.alreadyStopped,
            inFlightWrites: result.inFlightWrites,
            stopGeneration: result.stopGeneration,
          });
          return result;
        } finally {
          this.#localStopsPending -= 1;
        }
      },
      getSafetyStatus: () => this.#safety.status(),
      getHealthStatus: () => this.getHealthStatus(),
      getOutstandingAuditWrites: () => this.#auditWrites.size,
      waitForAuditIdle: async () => {
        while (this.#auditWrites.size > 0) {
          await Promise.allSettled([...this.#auditWrites]);
        }
      },
      resumeSafety: async (
        generation: number,
        options: { signal?: AbortSignal } = {},
      ) => {
        const blockReason = this.#safety.resumeBlockReason(generation);
        if (
          blockReason !== undefined ||
          this.#localResumePending ||
          this.#localStopsPending > 0
        ) {
          const result: SafetyResumeResult = {
            ...this.#safety.status(),
            resumed: false,
            reason: blockReason ?? "resume-pending",
          };
          await abortable(
            this.#recordLocalSafety(
              "safety.resume.local",
              "deny",
              {
                resumed: false,
                inFlightWrites: result.inFlightWrites,
                stopGeneration: result.stopGeneration,
                reason: result.reason,
              },
              result.reason === "writes-in-flight" || result.reason === "resume-pending"
                ? "RESOURCE_CAPACITY"
                : undefined,
            ),
            options.signal,
          );
          return result;
        }

        this.#localResumePending = true;
        const invalidation = this.#localResumeInvalidation;
        const transactionController = new AbortController();
        this.#localResumeController = transactionController;
        try {
          const pendingStatus = this.#safety.status();
          try {
            await abortable(
              this.#recordLocalSafety("safety.resume.authorization.local", "allow", {
                phase: "authorization",
                authorizedGeneration: pendingStatus.stopGeneration,
                inFlightWrites: pendingStatus.inFlightWrites,
                stopGeneration: pendingStatus.stopGeneration,
              }),
              options.signal,
              transactionController.signal,
            );
          } catch (error) {
            if (
              transactionController.signal.aborted &&
              !options.signal?.aborted &&
              invalidation !== this.#localResumeInvalidation
            ) {
              const result: SafetyResumeResult = {
                ...this.#safety.status(),
                resumed: false,
                reason: "stop-superseded",
              };
              return result;
            }
            throw error;
          }
          if (options.signal?.aborted) {
            throw new Error("local-control-aborted");
          }
          if (
            transactionController.signal.aborted ||
            invalidation !== this.#localResumeInvalidation
          ) {
            const result: SafetyResumeResult = {
              ...this.#safety.status(),
              resumed: false,
              reason: "stop-superseded",
            };
            return result;
          }
          const result = this.#safety.resume(generation);
          if (!result.resumed) return result;
          return result;
        } finally {
          if (this.#localResumeController === transactionController) {
            this.#localResumeController = undefined;
          }
          this.#localResumePending = false;
        }
      },
    });
  }

  #stopSafetyLatch(): SafetyStatus & { stopped: true; alreadyStopped: boolean } {
    this.#localResumeInvalidation += 1;
    this.#localResumeController?.abort();
    return this.#safety.stop();
  }

  async #recordLocalSafety(
    action:
      | "safety.stop.local"
      | "safety.resume.authorization.local"
      | "safety.resume.local",
    decision: "allow" | "deny",
    metadata: Record<string, unknown>,
    errorCode?: ErrorCode,
  ): Promise<void> {
    await this.#writeAudit({
      timestamp: new Date(this.#clock()).toISOString(),
      action,
      mode: "commit",
      decision,
      ...(errorCode === undefined ? {} : { errorCode }),
      safetyStopped: this.#safety.isStopped(),
      idempotencyHit: false,
      metadata: redactSensitive({
        localControlPlane: true,
        ...metadata,
      }),
    });
  }

  #writeAudit(
    event: AuditEvent,
    reservation?: AuditWriteReservation,
  ): Promise<void> {
    const pending = writeAudit(reservation ?? this.#audit, event);
    this.#auditWrites.add(pending);
    void pending.then(
      () => this.#auditWrites.delete(pending),
      () => {
        this.#auditWrites.delete(pending);
        this.#observedAuditHealth = this.#audit.health?.().status ?? "degraded";
        if (this.#observedAuditHealth === "ready") {
          this.#observedAuditHealth = "degraded";
        }
      },
    );
    return pending;
  }

  #reserveAuditForStateChange(
    request: RequestEnvelope,
  ): AuditWriteReservation | null | undefined {
    if (
      request.mode !== "commit" ||
      (request.action !== "session.open" &&
        request.action !== "session.close" &&
        request.action !== "game.act")
    ) {
      return undefined;
    }
    if (this.#audit.reserveWrite !== undefined) {
      return this.#audit.reserveWrite() ?? null;
    }
    return this.#audit.isWritable?.() === false ? null : undefined;
  }

  async handle(
    raw: unknown,
    context?: unknown,
  ): Promise<BridgeResponse> {
    const trustedContext = snapshotRequestContext(context);
    const callerOwnerKey =
      trustedContext === undefined ? undefined : deriveSessionOwnerKey(trustedContext);
    const parsed = requestEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      const request = safeInvalidRequest(raw);
      const response = errorResponse(
        request,
        "INVALID_ENVELOPE",
        "The request envelope is invalid.",
      );
      await this.#record(request, response, false);
      return response;
    }

    const request = parsed.data;
    if (!isKnownBridgeAction(request.action)) {
      const response = errorResponse(
        request,
        "UNKNOWN_ACTION",
        "The requested bridge action is not registered.",
      );
      await this.#record(request, response, false);
      return response;
    }

    if (request.action === "bridge.describe") {
      const params = emptyParamsSchema.safeParse(request.params);
      const response = params.success
          ? successResponse(request, {
            protocolVersion: PROTOCOL_VERSION,
            actions: knownBridgeActions,
            safetyStopped: this.#safety.isStopped(),
            adapters: this.#registry.list().map(describeAdapter),
          })
        : errorResponse(request, "INVALID_PARAMS", "bridge.describe accepts no parameters.");
      await this.#record(request, response, false);
      return response;
    }

    if (request.action === "session.open") {
      return this.#openSession(request, trustedContext, callerOwnerKey);
    }

    return this.#withSession(request, callerOwnerKey, async (session) => {
      switch (request.action) {
        case "session.close":
          return this.#closeSession(request, session);
        case "game.observe":
          return this.#observe(request, session);
        case "game.act":
          return this.#act(request, session);
        case "safety.stop":
          return this.#stop(request, session);
        default:
          return errorResponse(request, "UNKNOWN_ACTION", "The action is not registered.");
      }
    });
  }

  async #openSession(
    request: RequestEnvelope,
    context: RequestContext | undefined,
    callerOwnerKey: SessionOwnerKey | undefined,
  ): Promise<BridgeResponse> {
    if (context === undefined || callerOwnerKey === undefined) {
      const response = errorResponse(
        request,
        "AUTHORIZATION_DENIED",
        "A trusted request context is required for session access.",
      );
      await this.#record(request, response, false);
      return response;
    }
    const parsed = sessionOpenParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      const response = errorResponse(
        request,
        "INVALID_PARAMS",
        "Session parameters are invalid or contain undeclared fields.",
      );
      await this.#record(request, response, false, undefined, undefined, callerOwnerKey);
      return response;
    }
    const adapter = this.#registry.get(parsed.data.adapterId);
    if (adapter === undefined) {
      const response = errorResponse(request, "ADAPTER_NOT_FOUND", "The adapter is not registered.");
      await this.#record(request, response, false, parsed.data.adapterId, undefined, callerOwnerKey);
      return response;
    }
    const available = this.#registry.capabilitiesFor(adapter.id)!;
    if (parsed.data.capabilities.some((capability) => !available.has(capability))) {
      const response = errorResponse(
        request,
        "CAPABILITY_DENIED",
        "One or more requested capabilities are not declared by the adapter.",
      );
      await this.#record(request, response, false, adapter.id, undefined, callerOwnerKey);
      return response;
    }
    const authorized = await this.#authorizer.authorize({
      adapterId: adapter.id,
      capabilities: parsed.data.capabilities,
      context,
    });
    if (!authorized) {
      const response = errorResponse(
        request,
        "AUTHORIZATION_DENIED",
        "The configured session authorizer denied this request.",
      );
      await this.#record(request, response, false, adapter.id, undefined, callerOwnerKey);
      return response;
    }
    const grant = await this.#grantProvider.grant({
      adapter,
      context,
      requestedCapabilities: parsed.data.capabilities,
      ...(parsed.data.ttlMs === undefined ? {} : { requestedTtlMs: parsed.data.ttlMs }),
    });
    const requestedCapabilities = new Set(parsed.data.capabilities);
    if (
      !grant.allowed ||
      grant.capabilities.some(
        (capability) =>
          !requestedCapabilities.has(capability) || !available.has(capability),
      )
    ) {
      const response = errorResponse(
        request,
        "AUTHORIZATION_DENIED",
        "The trusted capability profile denied this session grant.",
        { operationPhase: "pre-dispatch" },
      );
      await this.#record(request, response, false, adapter.id, undefined, callerOwnerKey);
      return response;
    }
    if (request.mode === "dry-run") {
      const response = successResponse(request, {
        wouldOpen: true,
        adapterId: adapter.id,
        capabilities: grant.capabilities,
        scope: grant.scope,
        ttlMs: grant.ttlMs,
        actionBudget: grant.totalActionBudget,
        perActionBudgets: grant.perActionBudgets,
      });
      await this.#record(request, response, false, adapter.id, undefined, callerOwnerKey);
      return response;
    }
    const auditReservation = this.#reserveAuditForStateChange(request);
    if (auditReservation === null) {
      return errorResponse(
        request,
        "RESOURCE_CAPACITY",
        "Durable audit capacity is unavailable for state-changing actions.",
      );
    }
    let session: Session;
    try {
      session = this.#sessions.open(
        callerOwnerKey,
        adapter.id,
        grant.capabilities,
        grant.ttlMs,
        {
          scope: grant.scope,
          totalActionBudget: grant.totalActionBudget,
          perActionBudgets: grant.perActionBudgets,
        },
      );
    } catch (error) {
      const response =
        error instanceof SessionCapacityError
          ? errorResponse(
              request,
              "RESOURCE_CAPACITY",
              "Session capacity is exhausted.",
            )
          : errorResponse(
              request,
              "INTERNAL_ERROR",
              "The bridge could not open a session.",
            );
      await this.#record(
        request,
        response,
        false,
        adapter.id,
        undefined,
        callerOwnerKey,
        auditReservation,
      );
      return response;
    }
    const response = successResponse(request, {
      sessionId: session.id,
      adapterId: session.adapterId,
      capabilities: [...session.capabilities].sort(),
      scope: session.scope,
      actionBudgetRemaining: session.actionBudgetRemaining,
      perActionBudgetRemaining: Object.fromEntries(session.perActionBudgetRemaining),
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
    await this.#record(request, response, false, adapter.id, {
      openedSessionTag: safeIdentifierTag(session.id),
    }, callerOwnerKey, auditReservation);
    return response;
  }

  async #withSession(
    request: RequestEnvelope,
    callerOwnerKey: SessionOwnerKey | undefined,
    operation: (session: Session) => Promise<BridgeResponse>,
  ): Promise<BridgeResponse> {
    if (callerOwnerKey === undefined) {
      const response = errorResponse(
        request,
        "AUTHORIZATION_DENIED",
        "A trusted request context is required for session access.",
      );
      await this.#record(request, response, false);
      return response;
    }
    if (request.sessionId === undefined) {
      const response = errorResponse(request, "SESSION_REQUIRED", "This action requires a session.");
      await this.#record(request, response, false, undefined, undefined, callerOwnerKey);
      return response;
    }
    const session = this.#sessions.find(request.sessionId);
    if (session === undefined) {
      const response = errorResponse(request, "SESSION_NOT_FOUND", "The session does not exist.");
      await this.#record(request, response, false, undefined, undefined, callerOwnerKey);
      return response;
    }

    if (callerOwnerKey !== session.ownerKey) {
      const response = errorResponse(
        request,
        "AUTHORIZATION_DENIED",
        "The caller is not authorized to use this session.",
      );
      await this.#record(
        request,
        response,
        false,
        session.adapterId,
        undefined,
        callerOwnerKey,
      );
      return response;
    }

    const status = this.#sessions.active(session.id);
    if (status.errorCode !== undefined) {
      const messages: Record<typeof status.errorCode, string> = {
        SESSION_NOT_FOUND: "The session does not exist.",
        SESSION_EXPIRED: "The session has expired.",
        SESSION_CLOSED: "The session is closed.",
      };
      const response = errorResponse(request, status.errorCode, messages[status.errorCode]);
      await this.#record(request, response, false, session.adapterId, undefined, callerOwnerKey);
      return response;
    }

    const fingerprint = canonicalJson(request);
    const cached = session.requests.get(request.requestId);
    if (cached !== undefined) {
      if (cached.fingerprint === fingerprint) {
        const cachedResponse =
          cached.state === "in-flight" ? await cached.responsePromise : cached.response;
        await this.#record(request, cachedResponse, true, session.adapterId, undefined, callerOwnerKey);
        return cachedResponse;
      }
      const response = errorResponse(
        request,
        "REQUEST_ID_REUSED",
        "The request ID was already used for a different request in this session.",
      );
      await this.#record(request, response, true, session.adapterId, undefined, callerOwnerKey);
      return response;
    }

    const requestCacheIsFull = session.requests.size >= session.requestCapacity;
    const closeCapacityBypass = requestCacheIsFull && request.action === "session.close";
    if (requestCacheIsFull && !closeCapacityBypass) {
      const response = errorResponse(
        request,
        "RESOURCE_CAPACITY",
        "The session request capacity is exhausted.",
      );
      await this.#record(request, response, false, session.adapterId, {
        capacity: "request-cache",
      }, callerOwnerKey);
      return response;
    }

    if (closeCapacityBypass) {
      const auditReservation = this.#reserveAuditForStateChange(request);
      if (auditReservation === null) {
        return errorResponse(
          request,
          "RESOURCE_CAPACITY",
          "Durable audit capacity is unavailable for state-changing actions.",
        );
      }
      const response = await this.#executeSessionOperation(request, session, operation);
      await this.#record(request, response, false, session.adapterId, {
        requestCapacityBypass: "session.close",
      }, callerOwnerKey, auditReservation);
      return response;
    }

    let resolveInFlight!: (response: BridgeResponse) => void;
    const responsePromise = new Promise<BridgeResponse>((resolve) => {
      resolveInFlight = resolve;
    });
    session.requests.set(request.requestId, {
      fingerprint,
      state: "in-flight",
      responsePromise,
    });

    const auditReservation = this.#reserveAuditForStateChange(request);
    if (auditReservation === null) {
      const response = errorResponse(
        request,
        "RESOURCE_CAPACITY",
        "Durable audit capacity is unavailable for state-changing actions.",
      );
      session.requests.set(request.requestId, {
        fingerprint,
        state: "completed",
        response,
      });
      resolveInFlight(response);
      return response;
    }

    const response = await this.#executeSessionOperation(request, session, operation);
    session.requests.set(request.requestId, {
      fingerprint,
      state: "completed",
      response,
    });
    resolveInFlight(response);
    await this.#record(
      request,
      response,
      false,
      session.adapterId,
      undefined,
      callerOwnerKey,
      auditReservation,
    );
    return response;
  }

  async #executeSessionOperation(
    request: RequestEnvelope,
    session: Session,
    operation: (session: Session) => Promise<BridgeResponse>,
  ): Promise<BridgeResponse> {
    try {
      return await operation(session);
    } catch {
      return errorResponse(
        request,
        "INTERNAL_ERROR",
        "The bridge could not complete the request.",
      );
    }
  }

  async #closeSession(request: RequestEnvelope, session: Session): Promise<BridgeResponse> {
    if (!emptyParamsSchema.safeParse(request.params).success) {
      return errorResponse(request, "INVALID_PARAMS", "session.close accepts no parameters.");
    }
    if (request.mode === "dry-run") {
      return successResponse(request, { wouldClose: true });
    }
    this.#sessions.close(session);
    return successResponse(request, { closed: true });
  }

  async #observe(request: RequestEnvelope, session: Session): Promise<BridgeResponse> {
    const parsed = adapterParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return errorResponse(
        request,
        "INVALID_PARAMS",
        "game.observe parameters are invalid or contain undeclared fields.",
      );
    }
    const adapterCheck = this.#boundAdapter(request, session, parsed.data.adapterId);
    if ("response" in adapterCheck) {
      return adapterCheck.response;
    }
    if (
      adapterCheck.adapter.observation.requiredCapabilities.some(
        (capability) => !session.capabilities.has(capability),
      )
    ) {
      return errorResponse(
        request,
        "CAPABILITY_DENIED",
        "The session does not grant observation capability.",
        { operationPhase: "pre-dispatch" },
      );
    }
    try {
      const output = validateAdapterOutput(
        adapterCheck.adapter.observation.outputSchema,
        adapterCheck.adapter.observation.maxResultBytes,
        await adapterCheck.adapter.observe(),
      );
      return output.valid
        ? successResponse(request, output.result)
        : errorResponse(
            request,
            output.code,
            "The adapter observation did not satisfy its declared output contract.",
            { operationPhase: "adapter-succeeded" },
          );
    } catch {
      return errorResponse(
        request,
        "RUNTIME_UNAVAILABLE",
        "The adapter is unavailable for observation.",
        { operationPhase: "adapter-rejected" },
      );
    }
  }

  async #act(request: RequestEnvelope, session: Session): Promise<BridgeResponse> {
    const parsed = gameActParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return errorResponse(
        request,
        "INVALID_PARAMS",
        "game.act parameters are invalid or contain undeclared fields.",
      );
    }
    const adapterCheck = this.#boundAdapter(request, session, parsed.data.adapterId);
    if ("response" in adapterCheck) {
      return adapterCheck.response;
    }
    const decision = this.#policy.authorizeGameAction(
      adapterCheck.adapter,
      parsed.data.gameAction,
      parsed.data.input,
      session.capabilities,
    );
    if (!decision.allowed) {
      return errorResponse(request, decision.code, decision.message, {
        operationPhase: "pre-dispatch",
      });
    }
    const definition = adapterCheck.adapter.actions[parsed.data.gameAction]!;
    if (request.mode === "dry-run" && definition.dryRunSemantics === "unsupported") {
      return errorResponse(
        request,
        "ACTION_NOT_ALLOWED",
        "The adapter contract does not support dry-run for this action.",
        { operationPhase: "pre-dispatch" },
      );
    }
    const executeAndValidate = async (): Promise<BridgeResponse> => {
      try {
        const result = await adapterCheck.adapter.execute(
          parsed.data.gameAction,
          decision.parsedInput,
          request.mode,
          {
            ...(parsed.data.expectedRevision === undefined
              ? {}
              : { expectedRevision: parsed.data.expectedRevision }),
          },
        );
        const output = validateAdapterOutput(
          definition.outputSchema,
          definition.maxResultBytes,
          result,
        );
        if (!output.valid) {
          if (request.mode === "commit" && definition.effectKind === "write") {
            this.#runtimeHealth = "faulted";
          }
          return errorResponse(
            request,
            output.code,
            "The adapter result did not satisfy its declared output contract.",
            {
              operationPhase:
                request.mode === "commit" && definition.effectKind === "write"
                  ? "outcome-unknown"
                  : "adapter-succeeded",
            },
          );
        }
        return successResponse(request, output.result);
      } catch (error) {
        if (error instanceof AdapterExecutionError) {
          if (error.code === "REVISION_CONFLICT") {
            return errorResponse(
              request,
              "REVISION_CONFLICT",
              "The adapter state revision no longer matches the expected revision.",
              { operationPhase: "pre-dispatch" },
            );
          }
          if (definition.adapterErrorCodes.includes(error.code)) {
            return errorResponse(
              request,
              "ADAPTER_REJECTED",
              "The adapter explicitly rejected the operation.",
              {
                operationPhase: "adapter-rejected",
                adapterError: { code: error.code },
              },
            );
          }
        }
        const outcomeUnknown =
          request.mode === "commit" &&
          definition.effectKind === "write" &&
          (!(error instanceof AdapterRuntimeError) || error.kind === "outcome-unknown");
        if (outcomeUnknown) {
          this.#runtimeHealth = "faulted";
          return errorResponse(
            request,
            "OUTCOME_UNKNOWN",
            "The action was dispatched but its outcome could not be confirmed.",
            { operationPhase: "outcome-unknown" },
          );
        }
        return errorResponse(
          request,
          "RUNTIME_UNAVAILABLE",
          "The adapter runtime is unavailable.",
          { operationPhase: "adapter-rejected" },
        );
      }
    };

    if (request.mode !== "commit" || definition.effectKind !== "write") {
      return executeAndValidate();
    }

    const health = this.getHealthStatus();
    if (
      health.runtime.status !== "ready" ||
      health.adapter.status !== "ready" ||
      health.audit.status === "full" ||
      health.audit.status === "corrupt" ||
      health.audit.status === "closed"
    ) {
      return errorResponse(
        request,
        "RUNTIME_UNAVAILABLE",
        "Runtime health does not permit a new state-changing action.",
        { operationPhase: "pre-dispatch" },
      );
    }
    const concurrency = definition.writeConcurrency;
    if (concurrency.kind !== "resource-serial") {
      return errorResponse(
        request,
        "INTERNAL_ERROR",
        "The registered write action lacks a safe resource schedule.",
        { operationPhase: "pre-dispatch" },
      );
    }
    if (this.#safety.isStopped()) {
      return errorResponse(
        request,
        "SAFETY_STOPPED",
        "State-changing actions are disabled by the safety latch.",
        { operationPhase: "pre-dispatch" },
      );
    }
    const resourcePermit = this.#writeScheduler.tryAcquire(
      `${adapterCheck.adapter.id}\u0000${session.scope.kind}\u0000${session.scope.resourceId}\u0000${concurrency.resourceKey}`,
    );
    if (resourcePermit === undefined) {
      return errorResponse(
        request,
        "RESOURCE_CAPACITY",
        "The target resource already has a write in flight.",
        { operationPhase: "pre-dispatch" },
      );
    }
    const writePermit = this.#safety.beginWrite();
    if (!writePermit.allowed) {
      resourcePermit.release();
      return writePermit.reason === "stopped"
        ? errorResponse(
            request,
            "SAFETY_STOPPED",
            "State-changing actions are disabled by the safety latch.",
            { operationPhase: "pre-dispatch" },
          )
        : errorResponse(
            request,
            "RESOURCE_CAPACITY",
            "Concurrent write capacity is exhausted.",
            { operationPhase: "pre-dispatch" },
          );
    }
    try {
      if (
        definition.requiresExpectedRevision &&
        parsed.data.expectedRevision === undefined
      ) {
        return errorResponse(
          request,
          "REVISION_REQUIRED",
          "This write action requires an expected state revision.",
          { operationPhase: "pre-dispatch" },
        );
      }
      if (definition.requiresExpectedRevision) {
        let currentRevision: number;
        try {
          currentRevision = await adapterCheck.adapter.getStateRevision();
        } catch {
          return errorResponse(
            request,
            "RUNTIME_UNAVAILABLE",
            "The adapter state revision is unavailable.",
            { operationPhase: "pre-dispatch" },
          );
        }
        if (
          !Number.isSafeInteger(currentRevision) ||
          currentRevision < 0 ||
          parsed.data.expectedRevision !== currentRevision
        ) {
          return errorResponse(
            request,
            "REVISION_CONFLICT",
            "The expected revision does not match the current adapter state.",
            { operationPhase: "pre-dispatch" },
          );
        }
      }
      if (!reserveSessionActionBudget(session, parsed.data.gameAction)) {
        return errorResponse(
          request,
          "RESOURCE_CAPACITY",
          "The session action budget is exhausted.",
          { operationPhase: "pre-dispatch" },
        );
      }
      return await executeAndValidate();
    } finally {
      writePermit.release();
      resourcePermit.release();
    }
  }

  async #stop(request: RequestEnvelope, session: Session): Promise<BridgeResponse> {
    if (!emptyParamsSchema.safeParse(request.params).success) {
      return errorResponse(request, "INVALID_PARAMS", "safety.stop accepts no parameters.");
    }
    if (!session.capabilities.has("safety.stop")) {
      return errorResponse(
        request,
        "CAPABILITY_DENIED",
        "The session does not grant safety-stop capability.",
      );
    }
    if (request.mode === "dry-run") {
      return successResponse(request, { wouldStop: true, stopped: this.#safety.isStopped() });
    }
    return successResponse(request, this.#stopSafetyLatch());
  }

  #boundAdapter(
    request: RequestEnvelope,
    session: Session,
    requestedAdapterId: string,
  ):
    | { adapter: NonNullable<ReturnType<AdapterRegistry["get"]>> }
    | { response: BridgeResponse } {
    if (requestedAdapterId !== session.adapterId) {
      return {
        response: errorResponse(
          request,
          "ADAPTER_MISMATCH",
          "The requested adapter does not match the session-bound adapter.",
        ),
      };
    }
    const adapter = this.#registry.get(session.adapterId);
    if (adapter === undefined) {
      return {
        response: errorResponse(request, "ADAPTER_NOT_FOUND", "The adapter is not registered."),
      };
    }
    return { adapter };
  }

  async #record(
    request: RequestEnvelope,
    response: BridgeResponse,
    idempotencyHit: boolean,
    adapterId?: string,
    metadata?: unknown,
    callerOwnerKey?: SessionOwnerKey,
    auditReservation?: AuditWriteReservation,
  ): Promise<void> {
    if (
      !response.ok &&
      response.error.code === "RESOURCE_CAPACITY" &&
      auditReservation === undefined &&
      this.#audit.isWritable?.() === false
    ) {
      return;
    }
    const actionIsRegistered = isKnownBridgeAction(request.action);
    const adapterIsRegistered =
      adapterId !== undefined && this.#registry.get(adapterId) !== undefined;
    let submitted = false;
    try {
      const event: AuditEvent = {
        timestamp: new Date(this.#clock()).toISOString(),
        ...(callerOwnerKey === undefined
          ? {}
          : { callerTag: sessionCallerTag(callerOwnerKey, this.#callerTagKey) }),
        requestIdTag: safeIdentifierTag(request.requestId)!,
        ...(request.sessionId === undefined
          ? {}
          : { sessionIdTag: safeIdentifierTag(request.sessionId)! }),
        ...(adapterId === undefined
          ? {}
          : adapterIsRegistered
            ? { adapterId }
            : { adapterIdTag: safeIdentifierTag(adapterId)! }),
        action: actionIsRegistered ? request.action : "unregistered",
        ...(actionIsRegistered ? {} : { actionTag: safeIdentifierTag(request.action)! }),
        mode: request.mode,
        decision: response.ok ? "allow" : "deny",
        ...(!response.ok ? { errorCode: response.error.code } : {}),
        safetyStopped: this.#safety.isStopped(),
        idempotencyHit,
        ...(metadata === undefined ? {} : { metadata: redactSensitive(metadata) }),
      };
      submitted = true;
      try {
        await this.#writeAudit(event, auditReservation);
      } catch (error) {
        const auditIsSafetyCritical =
          request.mode === "commit" &&
          (request.action === "session.open" ||
            request.action === "session.close" ||
            request.action === "game.act" ||
            request.action === "safety.stop");
        if (auditIsSafetyCritical) throw error;
      }
    } finally {
      if (!submitted) auditReservation?.release();
    }
  }
}
