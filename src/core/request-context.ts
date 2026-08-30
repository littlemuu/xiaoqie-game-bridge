import { createHash } from "node:crypto";

export const MAX_PRINCIPAL_FIELD_LENGTH = 128;

export interface LocalRequestContext {
  readonly transport: "local";
}

export interface RemoteRequestContext {
  readonly transport: "remote";
  readonly principal: Readonly<{
    subject: string;
    method: string;
  }>;
}

export type RequestContext = LocalRequestContext | RemoteRequestContext;

declare const sessionOwnerKeyBrand: unique symbol;
export type SessionOwnerKey = string & {
  readonly [sessionOwnerKeyBrand]: true;
};

function hasExactDataProperties(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !keys.includes(key)) ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function isBoundedPrincipalField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_PRINCIPAL_FIELD_LENGTH
  );
}

/**
 * Validates, copies, and deeply freezes caller-controlled context synchronously.
 * Undefined is intentionally untrusted rather than an implicit local caller.
 */
export function snapshotRequestContext(value: unknown): RequestContext | undefined {
  try {
    if (hasExactDataProperties(value, ["transport"]) && value.transport === "local") {
      return Object.freeze({ transport: "local" });
    }
    if (
      !hasExactDataProperties(value, ["transport", "principal"]) ||
      value.transport !== "remote" ||
      !hasExactDataProperties(value.principal, ["subject", "method"]) ||
      !isBoundedPrincipalField(value.principal.subject) ||
      !isBoundedPrincipalField(value.principal.method)
    ) {
      return undefined;
    }
    const principal = Object.freeze({
      subject: value.principal.subject,
      method: value.principal.method,
    });
    return Object.freeze({ transport: "remote", principal });
  } catch {
    return undefined;
  }
}

function lengthPrefixed(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded]);
}

function domainHash(domain: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(lengthPrefixed(domain));
  for (const field of fields) {
    hash.update(lengthPrefixed(field));
  }
  return hash.digest("hex");
}

export function deriveSessionOwnerKey(context: RequestContext): SessionOwnerKey {
  const fields =
    context.transport === "local"
      ? ["transport", "local", "scope", "process-local"]
      : [
          "transport",
          "remote",
          "method",
          context.principal.method,
          "subject",
          context.principal.subject,
        ];
  return domainHash("xiaoqie-game-bridge/session-owner/v1", fields) as SessionOwnerKey;
}

export function sessionCallerTag(ownerKey: SessionOwnerKey): string {
  return domainHash("xiaoqie-game-bridge/session-caller-tag/v1", [ownerKey]).slice(0, 12);
}

export function isSessionOwnerKey(value: unknown): value is SessionOwnerKey {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
