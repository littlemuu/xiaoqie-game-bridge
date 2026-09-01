import type { SafetyStatus } from "./safety-latch.js";

export type RuntimeHealthStatus = "ready" | "degraded" | "quiescing" | "faulted";
export type AdapterHealthStatus = "ready" | "unavailable" | "faulted";
export type AuditHealthStatus = "ready" | "degraded" | "full" | "corrupt" | "closed";

export interface BridgeHealthStatus {
  runtime: {
    status: RuntimeHealthStatus;
  };
  adapter: {
    status: AdapterHealthStatus;
    registeredAdapters: number;
  };
  audit: {
    status: AuditHealthStatus;
    outstandingWrites: number;
  };
  safety: SafetyStatus;
}
