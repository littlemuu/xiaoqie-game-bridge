import { randomUUID } from "node:crypto";
import type { BridgeResponse, ErrorCode } from "./protocol.js";

export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1_000;
export const MAX_SESSION_TTL_MS = 60 * 60 * 1_000;

export interface CachedRequest {
  fingerprint: string;
  response: BridgeResponse;
}

export interface Session {
  id: string;
  adapterId: string;
  capabilities: Set<string>;
  createdAt: number;
  expiresAt: number;
  closedAt?: number;
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
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #clock: () => number;
  readonly #idGenerator: () => string;

  constructor(options: SessionManagerOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  now(): number {
    return this.#clock();
  }

  open(adapterId: string, capabilities: Iterable<string>, ttlMs?: number): Session {
    const effectiveTtl = ttlMs ?? DEFAULT_SESSION_TTL_MS;
    if (effectiveTtl <= 0 || effectiveTtl > MAX_SESSION_TTL_MS) {
      throw new RangeError("Session TTL must be between 1 ms and 60 minutes.");
    }
    const now = this.now();
    const session: Session = {
      id: this.#idGenerator(),
      adapterId,
      capabilities: new Set(capabilities),
      createdAt: now,
      expiresAt: now + effectiveTtl,
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
    session.closedAt = this.now();
  }
}
