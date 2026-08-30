import { createHash } from "node:crypto";
import type { BridgeMode, ErrorCode } from "./protocol.js";

const sensitiveKeyPattern =
  /(?:authorization|cookie|password|passwd|secret|token|credential|api[-_]?key|principal|subject|owner[-_]?(?:key|digest))/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactSensitive(child),
      ]),
    );
  }
  return value;
}

export function safeIdentifierTag(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export interface AuditEvent {
  timestamp: string;
  callerTag?: string;
  requestIdTag?: string;
  sessionIdTag?: string;
  adapterId?: string;
  adapterIdTag?: string;
  action: string;
  actionTag?: string;
  mode: BridgeMode;
  decision: "allow" | "deny";
  errorCode?: ErrorCode;
  safetyStopped: boolean;
  idempotencyHit: boolean;
  metadata?: unknown;
}

export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  write(event: AuditEvent): void {
    this.events.push(redactSensitive(event) as AuditEvent);
  }
}

export async function writeAudit(
  sink: AuditSink,
  event: AuditEvent,
): Promise<void> {
  await sink.write(redactSensitive(event) as AuditEvent);
}
