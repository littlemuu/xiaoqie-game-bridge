import { z } from "zod";

export const OPERATOR_PROTOCOL_VERSION = "1.0" as const;
export const OPERATOR_MAX_MESSAGE_BYTES = 2 * 1_024;
export const OPERATOR_MAX_FRAME_BYTES = 4 * 1_024;
export const OPERATOR_MAX_DESCRIPTOR_BYTES = 1_024;
export const OPERATOR_TOKEN_BYTES = 32;
export const OPERATOR_PIPE_PREFIX = "\\\\.\\pipe\\xiaoqie-game-bridge-";

const tokenSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/);
const generationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const operatorSafetyStatusSchema = z
  .object({
    stopped: z.boolean(),
    inFlightWrites: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    maxInFlightWrites: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    stopGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const requestBaseSchema = z.object({
  version: z.literal(OPERATOR_PROTOCOL_VERSION),
  token: tokenSchema,
});

export const operatorRequestSchema = z.discriminatedUnion("command", [
  requestBaseSchema.extend({ command: z.literal("status") }).strict(),
  requestBaseSchema.extend({ command: z.literal("stop") }).strict(),
  requestBaseSchema
    .extend({ command: z.literal("resume"), generation: generationSchema })
    .strict(),
]);

export const operatorErrorCodeSchema = z.enum([
  "AUTHENTICATION_FAILED",
  "CAPACITY",
  "GENERATION_MISMATCH",
  "INTERNAL_ERROR",
  "INVALID_REQUEST",
  "NOT_STOPPED",
  "TIMEOUT",
  "WRITES_IN_FLIGHT",
]);

const responseBaseSchema = z.object({
  version: z.literal(OPERATOR_PROTOCOL_VERSION),
  type: z.literal("result"),
});

export const operatorResponseSchema = z.union([
  responseBaseSchema
    .extend({
      ok: z.literal(true),
      command: z.literal("status"),
      status: operatorSafetyStatusSchema,
    })
    .strict(),
  responseBaseSchema
    .extend({
      ok: z.literal(true),
      command: z.literal("stop"),
      status: operatorSafetyStatusSchema,
      alreadyStopped: z.boolean(),
    })
    .strict(),
  responseBaseSchema
    .extend({
      ok: z.literal(true),
      command: z.literal("resume"),
      status: operatorSafetyStatusSchema,
    })
    .strict(),
  responseBaseSchema
    .extend({
      ok: z.literal(false),
      error: z.object({ code: operatorErrorCodeSchema }).strict(),
    })
    .strict(),
]);

export const operatorDescriptorSchema = z
  .object({
    version: z.literal(OPERATOR_PROTOCOL_VERSION),
    transport: z.literal("windows-named-pipe"),
    endpoint: z.string().refine((value) => {
      if (!value.startsWith(OPERATOR_PIPE_PREFIX)) return false;
      return /^[a-f0-9]{32}$/.test(value.slice(OPERATOR_PIPE_PREFIX.length));
    }),
    token: tokenSchema,
  })
  .strict();

export type OperatorRequest = z.infer<typeof operatorRequestSchema>;
export type OperatorResponse = z.infer<typeof operatorResponseSchema>;
export type OperatorErrorCode = z.infer<typeof operatorErrorCodeSchema>;
export type OperatorDescriptor = z.infer<typeof operatorDescriptorSchema>;

export function encodeOperatorFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > OPERATOR_MAX_MESSAGE_BYTES) {
    throw new Error("Operator message exceeds the fixed logical limit.");
  }
  return Buffer.concat([payload, Buffer.from("\n")]);
}
