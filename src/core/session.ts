import { randomUUID } from "node:crypto";
import type { BridgeResponse, ErrorCode } from "./protocol.js";

export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1_000;
export const MAX_SESSION_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_MAX_SESSIONS = 64;
export const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_REQUESTS_PER_SESSION = 256;

export class SessionCapacityError extends Error {
  constructor() {
    super("Session capacity is exhausted.");
    this.name = "SessionCapacityError";
  }
}

export interface InFlightRequest {
  fingerprint: string;
  state: "in-flight";
  responsePromise: Promise<BridgeResponse>;
}

export interface CompletedRequest {
  fingerprint: string;
  state: "completed";
  response: BridgeResponse;
}

export type CachedRequest = InFlightRequest | CompletedRequest;

export interface Session {
  id: string;
  adapterId: string;
  capabilities: Set<string>;
  createdAt: number;
  expiresAt: number;
  closedAt?: number;
  readonly requestCapacity: number;
  requests: Map<string, CachedRequest>;
}

export interface SessionStatus {
  session?: Session;
  errorCode?: Extract<
    ErrorCode,
    "SESSION_NOT_FOUND" | "SESSION_EXPIRED" | "SESSION_CLOSED"
  >;
}

export interface SessionManagerOptions {
  clock?: () => number;
  idGenerator?: () => string;
  maxSessions?: number;
  terminalRetentionMs?: number;
  maxRequestsPerSession?: number;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #clock: () => number;
  readonly #idGenerator: () => string;
  readonly #maxSessions: number;
  readonly #terminalRetentionMs: number;
  readonly #maxRequestsPerSession: number;

  constructor(options: SessionManagerOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#terminalRetentionMs =
      options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.#maxRequestsPerSession =
      options.maxRequestsPerSession ?? DEFAULT_MAX_REQUESTS_PER_SESSION;
    requirePositiveInteger("maxSessions", this.#maxSessions);
    requireNonNegativeInteger("terminalRetentionMs", this.#terminalRetentionMs);
    requirePositiveInteger("maxRequestsPerSession", this.#maxRequestsPerSession);
  }

  now(): number {
    return this.#clock();
  }

  open(adapterId: string, capabilities: Iterable<string>, ttlMs?: number): Session {
    const effectiveTtl = ttlMs ?? DEFAULT_SESSION_TTL_MS;
    if (effectiveTtl <= 0 || effectiveTtl > MAX_SESSION_TTL_MS) {
      throw new RangeError("Session TTL must be between 1 ms and 60 minutes.");
    }
    this.sweep();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new SessionCapacityError();
    }
    const now = this.now();
    const session: Session = {
      id: this.#idGenerator(),
      adapterId,
      capabilities: new Set(capabilities),
      createdAt: now,
      expiresAt: now + effectiveTtl,
      requestCapacity: this.#maxRequestsPerSession,
      requests: new Map(),
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  find(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  active(sessionId: string): SessionStatus {
    const session = this.find(sessionId);
    if (session === undefined) {
      return { errorCode: "SESSION_NOT_FOUND" };
    }
    if (session.closedAt !== undefined) {
      return { session, errorCode: "SESSION_CLOSED" };
    }
    if (this.now() >= session.expiresAt) {
      return { session, errorCode: "SESSION_EXPIRED" };
    }
    return { session };
  }

  close(session: Session): void {
    session.closedAt ??= this.now();
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [sessionId, session] of this.#sessions) {
      const terminalAt =
        session.closedAt ??
        (now >= session.expiresAt ? session.expiresAt : undefined);
      const hasInFlightRequest = [...session.requests.values()].some(
        (request) => request.state === "in-flight",
      );
      if (
        terminalAt !== undefined &&
        now - terminalAt >= this.#terminalRetentionMs &&
        !hasInFlightRequest
      ) {
        this.#sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#sessions.size;
  }
}
