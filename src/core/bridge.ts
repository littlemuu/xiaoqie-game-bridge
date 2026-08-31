import { z } from "zod";
import { randomBytes } from "node:crypto";
import { AdapterExecutionError, describeAdapter } from "./adapter.js";
import { AdapterRegistry } from "./adapter-registry.js";
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
  type BridgeResponse,
  type ErrorCode,
  type RequestEnvelope,
  errorResponse,
  isKnownBridgeAction,
  knownBridgeActions,
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
} from "./session.js";

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
  clock?: () => number;
  callerTagKey?: Uint8Array;
}

export interface BridgeLocalControlPlane {
  stopSafety(): Promise<SafetyStatus & { stopped: true; alreadyStopped: boolean }>;
  getSafetyStatus(): SafetyStatus;
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    protocolVersion: "1.0",
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    action,
    params: {},
    mode,
  };
}

const PROCESS_CALLER_TAG_KEY = randomBytes(CALLER_TAG_KEY_BYTES);

export class GameBridge {
  readonly #registry: AdapterRegistry;
  readonly #sessions: SessionManager;
  readonly #policy: PolicyEngine;
  readonly #safety: SafetyLatch;
  readonly #audit: AuditSink;
  readonly #authorizer: SessionAuthorizer;
  readonly #clock: () => number;
  readonly #callerTagKey: Buffer;
  readonly #auditWrites = new Set<Promise<void>>();
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
    this.#clock = options.clock ?? Date.now;
    const callerTagKey = options.callerTagKey ?? PROCESS_CALLER_TAG_KEY;
    if (!(callerTagKey instanceof Uint8Array) || callerTagKey.byteLength !== CALLER_TAG_KEY_BYTES) {
      throw new RangeError("callerTagKey must contain exactly 32 bytes.");
    }
    this.#callerTagKey = Buffer.from(callerTagKey);
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
      () => this.#auditWrites.delete(pending),
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
            protocolVersion: "1.0",
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
    if (request.mode === "dry-run") {
      const response = successResponse(request, {
        wouldOpen: true,
        adapterId: adapter.id,
        capabilities: [...new Set(parsed.data.capabilities)].sort(),
        ttlMs: parsed.data.ttlMs ?? 15 * 60 * 1_000,
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
        parsed.data.capabilities,
        parsed.data.ttlMs,
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

    const fingerprint = stableStringify(request);
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
    } catch (error) {
      return error instanceof AdapterExecutionError
        ? errorResponse(request, error.code, error.message)
        : errorResponse(
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
    if (!session.capabilities.has(adapterCheck.adapter.observationCapability)) {
      return errorResponse(
        request,
        "CAPABILITY_DENIED",
        "The session does not grant observation capability.",
      );
    }
    return successResponse(request, await adapterCheck.adapter.observe());
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
      return errorResponse(request, decision.code, decision.message);
    }
    if (request.mode === "dry-run") {
      const result = await adapterCheck.adapter.execute(
        parsed.data.gameAction,
        decision.parsedInput,
        request.mode,
      );
      return successResponse(request, result);
    }

    const writePermit = this.#safety.beginWrite();
    if (!writePermit.allowed) {
      return writePermit.reason === "stopped"
        ? errorResponse(
            request,
            "SAFETY_STOPPED",
            "State-changing actions are disabled by the safety latch.",
          )
        : errorResponse(
            request,
            "RESOURCE_CAPACITY",
            "Concurrent write capacity is exhausted.",
          );
    }
    try {
      const result = await adapterCheck.adapter.execute(
        parsed.data.gameAction,
        decision.parsedInput,
        request.mode,
      );
      return successResponse(request, result);
    } finally {
      writePermit.release();
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
      await this.#writeAudit(event, auditReservation);
    } finally {
      if (!submitted) auditReservation?.release();
    }
  }
}
