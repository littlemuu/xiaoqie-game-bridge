import { createHash, createHmac } from "node:crypto";

export const MAX_PRINCIPAL_FIELD_LENGTH = 128;
export const CALLER_TAG_KEY_BYTES = 32;

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

function captureOwnDataProperties(
  value: unknown,
): ReadonlyMap<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const captured = new Map<string, unknown>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return undefined;
      }
      captured.set(key, descriptor.value);
    }
    return captured;
  } catch {
    return undefined;
  }
}

function hasExactKeys(
  captured: ReadonlyMap<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  return (
    captured.size === expectedKeys.length &&
    expectedKeys.every((key) => captured.has(key))
  );
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
    const context = captureOwnDataProperties(value);
    if (context === undefined) {
      return undefined;
    }
    const transport = context.get("transport");
    if (hasExactKeys(context, ["transport"]) && transport === "local") {
      return Object.freeze({ transport: "local" });
    }
    if (
      !hasExactKeys(context, ["transport", "principal"]) ||
      transport !== "remote"
    ) {
      return undefined;
    }
    const capturedPrincipal = captureOwnDataProperties(context.get("principal"));
    if (
      capturedPrincipal === undefined ||
      !hasExactKeys(capturedPrincipal, ["subject", "method"])
    ) {
      return undefined;
    }
    const subject = capturedPrincipal.get("subject");
    const method = capturedPrincipal.get("method");
    if (!isBoundedPrincipalField(subject) || !isBoundedPrincipalField(method)) {
      return undefined;
    }
    const principal = Object.freeze({
      subject,
      method,
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

export function sessionCallerTag(
  ownerKey: SessionOwnerKey,
  secretKey: Uint8Array,
): string {
  if (secretKey.byteLength !== CALLER_TAG_KEY_BYTES) {
    throw new RangeError("Caller tag key must contain exactly 32 bytes.");
  }
  const hmac = createHmac("sha256", secretKey);
  hmac.update(lengthPrefixed("xiaoqie-game-bridge/session-caller-tag/v2"));
  hmac.update(lengthPrefixed(ownerKey));
  return hmac.digest("hex").slice(0, 12);
}

export function isSessionOwnerKey(value: unknown): value is SessionOwnerKey {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
