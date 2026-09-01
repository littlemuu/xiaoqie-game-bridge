import type { GameAdapter } from "./adapter.js";
import type { RequestContext } from "./request-context.js";
import {
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
} from "./session.js";

export interface ResourceScopeSummary {
  kind: string;
  resourceId: string;
}

export interface CapabilityGrantRequest {
  adapter: GameAdapter;
  context: RequestContext;
  requestedCapabilities: readonly string[];
  requestedTtlMs?: number;
}

export interface ApprovedCapabilityGrant {
  allowed: true;
  capabilities: readonly string[];
  scope: Readonly<ResourceScopeSummary>;
  ttlMs: number;
  totalActionBudget: number;
  perActionBudgets: Readonly<Record<string, number>>;
}

export interface DeniedCapabilityGrant {
  allowed: false;
}

export type CapabilityGrant = ApprovedCapabilityGrant | DeniedCapabilityGrant;

export interface CapabilityGrantProvider {
  grant(request: CapabilityGrantRequest): CapabilityGrant | Promise<CapabilityGrant>;
}

const GRANT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;
const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;

function captureRecord(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const result = new Map<string, unknown>();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    result.set(key, descriptor.value);
  }
  return result;
}

function hasKeys(record: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean {
  return record.size === keys.length && keys.every((key) => record.has(key));
}

function boundedName(value: unknown, pattern = GRANT_NAME_PATTERN): value is string {
  return typeof value === "string" && pattern.test(value);
}

function captureCapabilityArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
    )
  ) {
    return undefined;
  }
  const captured: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !boundedName(descriptor.value)
    ) {
      return undefined;
    }
    captured.push(descriptor.value);
  }
  return captured;
}

export function snapshotCapabilityGrant(
  value: unknown,
  request: CapabilityGrantRequest,
  availableCapabilities: ReadonlySet<string>,
): CapabilityGrant | undefined {
  try {
    const grant = captureRecord(value);
    if (grant === undefined || typeof grant.get("allowed") !== "boolean") return undefined;
    if (grant.get("allowed") === false) {
      return hasKeys(grant, ["allowed"])
        ? Object.freeze({ allowed: false as const })
        : undefined;
    }
    if (!hasKeys(grant, [
      "allowed",
      "capabilities",
      "scope",
      "ttlMs",
      "totalActionBudget",
      "perActionBudgets",
    ])) {
      return undefined;
    }

    const capabilities = captureCapabilityArray(grant.get("capabilities"));
    if (capabilities === undefined) return undefined;
    const requested = new Set(request.requestedCapabilities);
    if (
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some(
        (capability) =>
          !requested.has(capability) || !availableCapabilities.has(capability),
      )
    ) {
      return undefined;
    }

    const ttlMs = grant.get("ttlMs");
    const requestedTtlLimit = request.requestedTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (
      typeof ttlMs !== "number" ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > MAX_SESSION_TTL_MS ||
      ttlMs > requestedTtlLimit
    ) {
      return undefined;
    }

    const scopeValue = captureRecord(grant.get("scope"));
    if (scopeValue === undefined || !hasKeys(scopeValue, ["kind", "resourceId"])) {
      return undefined;
    }
    const scopeKind = scopeValue.get("kind");
    const resourceId = scopeValue.get("resourceId");
    if (
      !boundedName(scopeKind) ||
      (scopeKind !== request.adapter.id && !scopeKind.startsWith(`${request.adapter.id}.`)) ||
      !boundedName(resourceId, RESOURCE_ID_PATTERN)
    ) {
      return undefined;
    }

    const totalActionBudget = grant.get("totalActionBudget");
    if (
      typeof totalActionBudget !== "number" ||
      !Number.isSafeInteger(totalActionBudget) ||
      totalActionBudget < 0
    ) {
      return undefined;
    }
    const budgetsValue = captureRecord(grant.get("perActionBudgets"));
    if (budgetsValue === undefined) return undefined;
    const perActionBudgets: Record<string, number> = {};
    for (const [action, budget] of budgetsValue) {
      if (
        !GRANT_NAME_PATTERN.test(action) ||
        request.adapter.actions[action]?.effectKind !== "write" ||
        typeof budget !== "number" ||
        !Number.isSafeInteger(budget) ||
        budget < 0 ||
        budget > totalActionBudget
      ) {
        return undefined;
      }
      perActionBudgets[action] = budget;
    }

    return Object.freeze({
      allowed: true as const,
      capabilities: Object.freeze([...capabilities].sort()),
      scope: Object.freeze({ kind: scopeKind, resourceId }),
      ttlMs,
      totalActionBudget,
      perActionBudgets: Object.freeze(perActionBudgets),
    });
  } catch {
    return undefined;
  }
}

const MOCK_CAPABILITIES = Object.freeze([
  "game.observe",
  "game.act.move",
  "game.act.place_block",
  "safety.stop",
]);

export class TrustedMockGrantProvider implements CapabilityGrantProvider {
  grant(request: CapabilityGrantRequest): CapabilityGrant {
    if (request.context.transport !== "local" || request.adapter.id !== "mock-world") {
      return { allowed: false };
    }
    const approved = new Set(MOCK_CAPABILITIES);
    const requested = [...new Set(request.requestedCapabilities)].sort();
    if (requested.some((capability) => !approved.has(capability))) {
      return { allowed: false };
    }
    return {
      allowed: true,
      capabilities: Object.freeze(requested),
      scope: Object.freeze({ kind: "mock-world", resourceId: "tiny-world-v1" }),
      ttlMs: Math.min(request.requestedTtlMs ?? DEFAULT_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
      totalActionBudget: 128,
      perActionBudgets: Object.freeze({ move: 64, place_block: 64 }),
    };
  }
}
