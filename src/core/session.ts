import { randomUUID } from "node:crypto";
import type { BridgeResponse, ErrorCode } from "./protocol.js";
import { isSessionOwnerKey, type SessionOwnerKey } from "./request-context.js";
import type { ResourceScopeSummary } from "./grant.js";

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

export class SessionIdCollisionError extends Error {
  constructor() {
    super("The generated session identifier is already in use.");
    this.name = "SessionIdCollisionError";
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
  readonly ownerKey: SessionOwnerKey;
  adapterId: string;
  readonly capabilities: ReadonlySet<string>;
  readonly scope: Readonly<ResourceScopeSummary>;
  readonly actionBudgetRemaining: number;
  readonly perActionBudgetRemaining: ReadonlyMap<string, number>;
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

export interface SessionGrantSettings {
  scope: Readonly<ResourceScopeSummary>;
  totalActionBudget: number;
  perActionBudgets: Readonly<Record<string, number>>;
}

interface SessionBudgetState {
  actionBudgetRemaining: number;
  perActionBudgetRemaining: Map<string, number>;
}

const SESSION_BUDGETS = new WeakMap<Session, SessionBudgetState>();

function readonlySetView<T>(source: Set<T>): ReadonlySet<T> {
  let view!: ReadonlySet<T>;
  view = Object.freeze({
    get size() { return source.size; },
    has: (value: T) => source.has(value),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    [Symbol.iterator]: () => source[Symbol.iterator](),
    forEach: (callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) =>
      source.forEach((value, value2) => callback.call(thisArg, value, value2, view)),
  });
  return view;
}

function readonlyMapView<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  let view!: ReadonlyMap<K, V>;
  view = Object.freeze({
    get size() { return source.size; },
    has: (key: K) => source.has(key),
    get: (key: K) => source.get(key),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    [Symbol.iterator]: () => source[Symbol.iterator](),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) =>
      source.forEach((value, key) => callback.call(thisArg, value, key, view)),
  });
  return view;
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

  open(
    ownerKey: SessionOwnerKey,
    adapterId: string,
    capabilities: Iterable<string>,
    ttlMs: number | undefined,
    grant: SessionGrantSettings,
  ): Session {
    if (!isSessionOwnerKey(ownerKey)) {
      throw new TypeError("Session owner key must be a full SHA-256 digest.");
    }
    const effectiveTtl = ttlMs ?? DEFAULT_SESSION_TTL_MS;
    if (grant === undefined) {
      throw new TypeError("Session creation requires an explicit capability grant.");
    }
    if (
      !Number.isSafeInteger(effectiveTtl) ||
      effectiveTtl <= 0 ||
      effectiveTtl > MAX_SESSION_TTL_MS
    ) {
      throw new RangeError("Session TTL must be between 1 ms and 60 minutes.");
    }
    this.sweep();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new SessionCapacityError();
    }
    const now = this.now();
    requireNonNegativeInteger("totalActionBudget", grant.totalActionBudget);
    const perActionBudgetRemaining = new Map<string, number>();
    for (const [action, budget] of Object.entries(grant.perActionBudgets)) {
      if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(action)) {
        throw new TypeError("Per-action budget names must be closed manifest names.");
      }
      requireNonNegativeInteger(`perActionBudgets.${action}`, budget);
      perActionBudgetRemaining.set(action, budget);
    }
    const sessionId = this.#idGenerator();
    if (this.#sessions.has(sessionId)) {
      throw new SessionIdCollisionError();
    }
    const budgetState: SessionBudgetState = {
      actionBudgetRemaining: grant.totalActionBudget,
      perActionBudgetRemaining,
    };
    const capabilitySet = new Set(capabilities);
    const session: Session = {
      id: sessionId,
      ownerKey,
      adapterId,
      capabilities: readonlySetView(capabilitySet),
      scope: Object.freeze({ ...grant.scope }),
      get actionBudgetRemaining() { return budgetState.actionBudgetRemaining; },
      perActionBudgetRemaining: readonlyMapView(perActionBudgetRemaining),
      createdAt: now,
      expiresAt: now + effectiveTtl,
      requestCapacity: this.#maxRequestsPerSession,
      requests: new Map(),
    };
    Object.defineProperty(session, "ownerKey", {
      value: ownerKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(session, "capabilities", {
      value: session.capabilities,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(session, "actionBudgetRemaining", {
      get: () => budgetState.actionBudgetRemaining,
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(session, "perActionBudgetRemaining", {
      value: session.perActionBudgetRemaining,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    SESSION_BUDGETS.set(session, budgetState);
    Object.defineProperty(session, "scope", {
      value: session.scope,
      enumerable: true,
      writable: false,
      configurable: false,
    });
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

export interface SessionActionBudgetReservation {
  commit(): void;
  rollback(): void;
}

export function reserveSessionActionBudget(
  session: Session,
  action: string,
): SessionActionBudgetReservation | undefined {
  const budgetState = SESSION_BUDGETS.get(session);
  if (budgetState === undefined) {
    throw new TypeError("Session budget state is unavailable.");
  }
  const actionRemaining = budgetState.perActionBudgetRemaining.get(action);
  if (budgetState.actionBudgetRemaining < 1 || actionRemaining === 0) return undefined;
  budgetState.actionBudgetRemaining -= 1;
  if (actionRemaining !== undefined) {
    budgetState.perActionBudgetRemaining.set(action, actionRemaining - 1);
  }
  let settled = false;
  return Object.freeze({
    commit: () => {
      settled = true;
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      budgetState.actionBudgetRemaining += 1;
      if (actionRemaining !== undefined) {
        budgetState.perActionBudgetRemaining.set(action, actionRemaining);
      }
    },
  });
}
