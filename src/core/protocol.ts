import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;

export const bridgeModeSchema = z.enum(["dry-run", "commit"]);
export type BridgeMode = z.infer<typeof bridgeModeSchema>;

export const requestEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
    mode: bridgeModeSchema,
  })
  .strict();

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

export const errorCodes = [
  "INVALID_ENVELOPE",
  "UNKNOWN_ACTION",
  "INVALID_PARAMS",
  "SESSION_REQUIRED",
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "SESSION_CLOSED",
  "ADAPTER_NOT_FOUND",
  "ADAPTER_MISMATCH",
  "CAPABILITY_DENIED",
  "ACTION_NOT_ALLOWED",
  "SAFETY_STOPPED",
  "REQUEST_ID_REUSED",
  "RESOURCE_CAPACITY",
  "AUTHORIZATION_DENIED",
  "OUT_OF_BOUNDS",
  "BLOCK_NOT_ALLOWED",
  "TARGET_OCCUPIED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface BridgeError {
  code: ErrorCode;
  message: string;
}

interface ResponseBase {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId?: string;
  action: string;
  mode: BridgeMode;
}

export interface SuccessResponse extends ResponseBase {
  ok: true;
  result: unknown;
}

export interface ErrorResponse extends ResponseBase {
  ok: false;
  error: BridgeError;
}

export type BridgeResponse = SuccessResponse | ErrorResponse;

const responseBaseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128).optional(),
  action: z.string().min(1).max(128),
  mode: bridgeModeSchema,
});

export const responseEnvelopeSchema = z.discriminatedUnion("ok", [
  responseBaseSchema.extend({ ok: z.literal(true), result: z.unknown() }).strict(),
  responseBaseSchema
    .extend({
      ok: z.literal(false),
      error: z
        .object({ code: z.enum(errorCodes), message: z.string().min(1).max(512) })
        .strict(),
    })
    .strict(),
]);

export function successResponse(
  request: RequestEnvelope,
  result: unknown,
): SuccessResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    action: request.action,
    mode: request.mode,
    ok: true,
    result,
  };
}

export function errorResponse(
  request: Pick<RequestEnvelope, "requestId" | "sessionId" | "action" | "mode">,
  code: ErrorCode,
  message: string,
): ErrorResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    action: request.action,
    mode: request.mode,
    ok: false,
    error: { code, message },
  };
}

export const knownBridgeActions = [
  "bridge.describe",
  "session.open",
  "session.close",
  "game.observe",
  "game.act",
  "safety.stop",
] as const;

export type KnownBridgeAction = (typeof knownBridgeActions)[number];

export function isKnownBridgeAction(action: string): action is KnownBridgeAction {
  return (knownBridgeActions as readonly string[]).includes(action);
}
