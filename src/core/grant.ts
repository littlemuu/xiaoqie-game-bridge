import type { GameAdapter } from "./adapter.js";
import type { RequestContext } from "./request-context.js";
import { DEFAULT_SESSION_TTL_MS } from "./session.js";

export interface ResourceScopeSummary {
  kind: "mock-world" | "test-resource";
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
