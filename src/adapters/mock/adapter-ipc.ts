import { z } from "zod";
import {
  mockMoveInputSchema,
  mockMoveResultSchema,
  mockObservationResultSchema,
  mockPlaceBlockInputSchema,
  mockPlaceBlockResultSchema,
} from "./mock-adapter.js";

export const ADAPTER_IPC_VERSION = "1.0" as const;
export const ADAPTER_IPC_MAX_FRAME_BYTES = 64 * 1_024;
export const ADAPTER_IPC_MAX_MESSAGE_BYTES = 32 * 1_024;
export const ADAPTER_IPC_MAX_PENDING_CALLS = 8;
export const ADAPTER_IPC_HANDSHAKE_TIMEOUT_MS = 2_000;
export const ADAPTER_IPC_CALL_TIMEOUT_MS = 2_000;
export const ADAPTER_IPC_CLOSE_TIMEOUT_MS = 1_000;
export const CONTAINMENT_ATTESTATION_VERSION = 1 as const;
export const CONTAINMENT_ACTIVE_PROCESS_LIMIT = 1 as const;
export const CONTAINMENT_PROCESS_MEMORY_LIMIT_BYTES = 256 * 1_024 * 1_024;
export const CONTAINMENT_JOB_MEMORY_LIMIT_BYTES = 192 * 1_024 * 1_024;
export const CONTAINMENT_CPU_RATE_PERCENT = 20 as const;

export const MOCK_ADAPTER_IDENTITY = Object.freeze({
  id: "mock-world",
  displayName: "Deterministic in-memory mock world",
  observationCapability: "game.observe",
  actions: Object.freeze(["move", "place_block"]),
});

const baseSchema = z.object({ version: z.literal(ADAPTER_IPC_VERSION) });
const identitySchema = z
  .object({
    id: z.literal(MOCK_ADAPTER_IDENTITY.id),
    displayName: z.literal(MOCK_ADAPTER_IDENTITY.displayName),
    observationCapability: z.literal(MOCK_ADAPTER_IDENTITY.observationCapability),
    actions: z.tuple([z.literal("move"), z.literal("place_block")]),
  })
  .strict();
const callIdSchema = z.string().regex(/^call-[1-9][0-9]{0,15}$/);

export const containmentReadySchema = z
  .object({
    version: z.literal(CONTAINMENT_ATTESTATION_VERSION),
    type: z.literal("containment-ready"),
    attestation: z
      .object({
        tokenRestricted: z.literal(true),
        dangerousPrivilegesDisabled: z.literal(true),
        privilegedGroupsDisabledOrDenyOnly: z.literal(true),
        restrictingSidPolicy: z.literal("source-user-and-enabled-groups"),
        integrity: z.enum(["low", "medium"]),
        jobAssigned: z.literal(true),
        killOnClose: z.literal(true),
        activeProcessLimit: z.literal(CONTAINMENT_ACTIVE_PROCESS_LIMIT),
        processMemoryLimitBytes: z.literal(CONTAINMENT_PROCESS_MEMORY_LIMIT_BYTES),
        jobMemoryLimitBytes: z.literal(CONTAINMENT_JOB_MEMORY_LIMIT_BYTES),
        cpuRatePercent: z.literal(CONTAINMENT_CPU_RATE_PERCENT),
        breakawayAllowed: z.literal(false),
        hostJob: z.enum(["nested", "none"]),
      })
      .strict(),
  })
  .strict();
export const containmentFaultSchema = z
  .object({
    version: z.literal(CONTAINMENT_ATTESTATION_VERSION),
    type: z.literal("containment-fault"),
    category: z.enum(["memory-limit", "process-limit"]),
  })
  .strict();

export const adapterReadySchema = baseSchema
  .extend({ type: z.literal("ready"), adapter: identitySchema })
  .strict();
export const adapterCallSchema = z.union([
  baseSchema
    .extend({
      type: z.literal("call"),
      callId: callIdSchema,
      operation: z.literal("observe"),
    })
    .strict(),
  z.discriminatedUnion("action", [
    baseSchema
      .extend({
        type: z.literal("call"),
        callId: callIdSchema,
        operation: z.literal("execute"),
        action: z.literal("move"),
        input: mockMoveInputSchema,
        mode: z.enum(["dry-run", "commit"]),
        expectedRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict(),
    baseSchema
      .extend({
        type: z.literal("call"),
        callId: callIdSchema,
        operation: z.literal("execute"),
        action: z.literal("place_block"),
        input: mockPlaceBlockInputSchema,
        mode: z.enum(["dry-run", "commit"]),
        expectedRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict(),
  ]),
]);
export const adapterResultSchema = z.discriminatedUnion("ok", [
  baseSchema
    .extend({
      type: z.literal("result"),
      callId: callIdSchema,
      ok: z.literal(true),
      result: z.union([
        mockObservationResultSchema,
        mockMoveResultSchema,
        mockPlaceBlockResultSchema,
      ]),
    })
    .strict(),
  baseSchema
    .extend({
      type: z.literal("result"),
      callId: callIdSchema,
      ok: z.literal(false),
      error: z.object({
        code: z.enum([
          "OUT_OF_BOUNDS",
          "BLOCK_NOT_ALLOWED",
          "TARGET_OCCUPIED",
          "REVISION_CONFLICT",
          "ADAPTER_FAILURE",
        ]),
      }).strict(),
    })
    .strict(),
]);
export const adapterShutdownSchema = baseSchema
  .extend({ type: z.literal("shutdown") })
  .strict();
export const adapterShutdownCompleteSchema = baseSchema
  .extend({ type: z.literal("shutdown-complete") })
  .strict();

export const adapterParentMessageSchema = z.union([
  adapterCallSchema,
  adapterShutdownSchema,
]);
export const adapterWorkerMessageSchema = z.union([
  containmentReadySchema,
  containmentFaultSchema,
  adapterReadySchema,
  adapterResultSchema,
  adapterShutdownCompleteSchema,
]);

export type AdapterCall = z.infer<typeof adapterCallSchema>;
export type AdapterWorkerMessage = z.infer<typeof adapterWorkerMessageSchema>;
export type ContainmentAttestation = z.infer<typeof containmentReadySchema>["attestation"];

export function encodeAdapterFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > ADAPTER_IPC_MAX_MESSAGE_BYTES) {
    throw new Error("Adapter IPC message exceeds the fixed logical limit.");
  }
  return Buffer.concat([payload, Buffer.from("\n")]);
}
