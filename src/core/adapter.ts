import { z } from "zod";
import type { BridgeMode } from "./protocol.js";
import type { AdapterHealthStatus } from "./health.js";

export const ADAPTER_MAX_RESULT_BYTES = 32 * 1_024;
const ADAPTER_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MANIFEST_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;

export type AdapterEffectKind = "read" | "preview" | "write";
export type AdapterDryRunSemantics = "exact" | "best-effort" | "unsupported";
export type AdapterObservationConcurrency =
  | Readonly<{ kind: "parallel" }>
  | Readonly<{ kind: "serial" }>
  | Readonly<{ kind: "resource-serial"; resourceKey: string }>;
export type AdapterWriteConcurrency =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "resource-serial"; resourceKey: string }>;

export interface AdapterSchema {
  readonly jsonSchema?: unknown;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: unknown }>
    | Readonly<{ success: false }>;
}

export interface AdapterObservationDefinition {
  description: string;
  outputSchema: z.ZodType<unknown> | AdapterSchema;
  effectKind: "read";
  concurrency: AdapterObservationConcurrency;
  requiredCapabilities: readonly string[];
  maxResultBytes: number;
}

export interface AdapterActionDefinition {
  description: string;
  inputSchema: z.ZodType<unknown> | AdapterSchema;
  outputSchema: z.ZodType<unknown> | AdapterSchema;
  effectKind: AdapterEffectKind;
  dryRunSemantics: AdapterDryRunSemantics;
  requiredCapabilities: readonly string[];
  maxResultBytes: number;
  writeConcurrency: AdapterWriteConcurrency;
  adapterErrorCodes: readonly string[];
  requiresExpectedRevision: boolean;
  reconciliation: "unsupported" | "future";
}

export interface AdapterActionDescription {
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  effectKind: AdapterEffectKind;
  dryRunSemantics: AdapterDryRunSemantics;
  requiredCapabilities: readonly string[];
  maxResultBytes: number;
  writeConcurrency: AdapterWriteConcurrency;
  adapterErrorCodes: readonly string[];
  requiresExpectedRevision: boolean;
  reconciliation: "unsupported" | "future";
}

export interface AdapterDescription {
  id: string;
  displayName: string;
  observation: {
    description: string;
    outputSchema: unknown;
    effectKind: "read";
    concurrency: AdapterObservationConcurrency;
    requiredCapabilities: readonly string[];
    maxResultBytes: number;
  };
  actions: Record<string, AdapterActionDescription>;
}

export interface AdapterExecutionOptions {
  expectedRevision?: number;
}

export interface GameAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly observation: AdapterObservationDefinition;
  readonly actions: Readonly<Record<string, AdapterActionDefinition>>;
  observe(): Promise<unknown>;
  getStateRevision?(): Promise<number>;
  execute?(
    action: string,
    input: unknown,
    mode: BridgeMode,
    options?: AdapterExecutionOptions,
  ): Promise<unknown>;
  health?(): AdapterHealthStatus;
}

export class AdapterExecutionError extends Error {
  constructor(readonly code: string) {
    super("The adapter explicitly rejected the operation.");
    if (!ADAPTER_ERROR_CODE_PATTERN.test(code)) {
      throw new TypeError("Adapter error codes must use the closed uppercase namespace.");
    }
    this.name = "AdapterExecutionError";
  }
}

export class AdapterRuntimeError extends Error {
  constructor(
    readonly kind: "unavailable" | "outcome-unknown",
    readonly dispatch: "not-dispatched" | "dispatched" =
      kind === "outcome-unknown" ? "dispatched" : "not-dispatched",
  ) {
    super("The adapter runtime could not confirm the operation result.");
    this.name = "AdapterRuntimeError";
  }
}

function ownData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`Adapter manifest field ${key} must be an own data property.`);
  }
  return descriptor.value;
}

function manifestString(value: unknown, label: string, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function positiveResultLimit(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > ADAPTER_MAX_RESULT_BYTES
  ) {
    throw new TypeError(`${label} must be a positive bounded byte limit.`);
  }
  return value;
}

function stringSet(value: unknown, label: string, pattern = MANIFEST_NAME_PATTERN): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError(`${label} must be a bounded string array.`);
  }
  const values = value.map((entry) => manifestString(entry, label, pattern));
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} cannot contain duplicates.`);
  }
  return Object.freeze([...values].sort());
}

const CODE_BEARING_SCHEMA_TYPES = new Set([
  "catch",
  "custom",
  "default",
  "function",
  "lazy",
  "pipe",
  "prefault",
  "promise",
  "transform",
]);

function rejectCodeBearingSchema(value: object, label: string): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    const internal = candidate as { _zod?: { def?: unknown } };
    const definition = internal._zod?.def;
    if (definition !== null && typeof definition === "object") {
      const descriptor = definition as { type?: unknown; check?: unknown };
      if (
        (typeof descriptor.type === "string" &&
          CODE_BEARING_SCHEMA_TYPES.has(descriptor.type)) ||
        descriptor.check === "custom"
      ) {
        throw new TypeError(`${label} must use the declarative schema subset.`);
      }
    }
    for (const property of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
      if ("value" in property) visit(property.value);
    }
  };
  visit(value);
}

function deepFreezeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

function schemaSnapshot(value: unknown, label: string): AdapterSchema {
  if (!(value instanceof z.ZodType)) {
    throw new TypeError(`${label} must be a Zod schema.`);
  }
  try {
    rejectCodeBearingSchema(value, label);
    const jsonSchema = deepFreezeJson(
      JSON.parse(JSON.stringify(z.toJSONSchema(value))) as unknown,
    );
    const validator = z.fromJSONSchema(
      structuredClone(jsonSchema) as Parameters<typeof z.fromJSONSchema>[0],
    );
    return Object.freeze({
      jsonSchema,
      safeParse: (candidate: unknown) => {
        const result = validator.safeParse(candidate);
        return result.success
          ? Object.freeze({ success: true as const, data: result.data })
          : Object.freeze({ success: false as const });
      },
    });
  } catch (error) {
    if (error instanceof TypeError && /declarative schema subset/u.test(error.message)) {
      throw error;
    }
    throw new TypeError(`${label} cannot be represented as declarative JSON Schema.`);
  }
}

function schemaJson(schema: z.ZodType<unknown> | AdapterSchema): unknown {
  if (schema instanceof z.ZodType) return z.toJSONSchema(schema);
  if (schema.jsonSchema === undefined) {
    throw new TypeError("Registered adapter schema has no JSON representation.");
  }
  return schema.jsonSchema;
}

function snapshotObservation(value: unknown): AdapterObservationDefinition {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Adapter observation contract is invalid.");
  }
  if (ownData(value, "effectKind") !== "read") {
    throw new TypeError("Adapter observation effect kind must be read.");
  }
  const concurrency = snapshotObservationConcurrency(ownData(value, "concurrency"));
  return Object.freeze({
    description: manifestString(ownData(value, "description"), "observation description"),
    outputSchema: schemaSnapshot(ownData(value, "outputSchema"), "observation outputSchema"),
    effectKind: "read",
    concurrency,
    requiredCapabilities: stringSet(
      ownData(value, "requiredCapabilities"),
      "observation requiredCapabilities",
    ),
    maxResultBytes: positiveResultLimit(
      ownData(value, "maxResultBytes"),
      "observation maxResultBytes",
    ),
  });
}

function snapshotObservationConcurrency(value: unknown): AdapterObservationConcurrency {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Adapter observation concurrency contract is invalid.");
  }
  const kind = ownData(value, "kind");
  if (kind === "parallel" || kind === "serial") return Object.freeze({ kind });
  if (kind === "resource-serial") {
    return Object.freeze({
      kind,
      resourceKey: manifestString(
        ownData(value, "resourceKey"),
        "observation concurrency resourceKey",
        MANIFEST_NAME_PATTERN,
      ),
    });
  }
  throw new TypeError("Adapter observation concurrency kind is invalid.");
}

function snapshotConcurrency(value: unknown): AdapterWriteConcurrency {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Adapter write concurrency contract is invalid.");
  }
  const kind = ownData(value, "kind");
  if (kind === "none") return Object.freeze({ kind });
  if (kind === "resource-serial") {
    return Object.freeze({
      kind,
      resourceKey: manifestString(
        ownData(value, "resourceKey"),
        "write concurrency resourceKey",
        MANIFEST_NAME_PATTERN,
      ),
    });
  }
  throw new TypeError("Adapter write concurrency kind is invalid.");
}

function snapshotAction(value: unknown, actionName: string): AdapterActionDefinition {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`Adapter action ${actionName} is invalid.`);
  }
  const effectKind = ownData(value, "effectKind");
  const dryRunSemantics = ownData(value, "dryRunSemantics");
  const reconciliation = ownData(value, "reconciliation");
  const requiresExpectedRevision = ownData(value, "requiresExpectedRevision");
  if (effectKind !== "read" && effectKind !== "preview" && effectKind !== "write") {
    throw new TypeError(`Adapter action ${actionName} has an invalid effect kind.`);
  }
  if (
    dryRunSemantics !== "exact" &&
    dryRunSemantics !== "best-effort" &&
    dryRunSemantics !== "unsupported"
  ) {
    throw new TypeError(`Adapter action ${actionName} has invalid dry-run semantics.`);
  }
  if (reconciliation !== "unsupported" && reconciliation !== "future") {
    throw new TypeError(`Adapter action ${actionName} has invalid reconciliation metadata.`);
  }
  if (typeof requiresExpectedRevision !== "boolean") {
    throw new TypeError(`Adapter action ${actionName} has invalid revision metadata.`);
  }
  const concurrency = snapshotConcurrency(ownData(value, "writeConcurrency"));
  if (effectKind === "write" && concurrency.kind !== "resource-serial") {
    throw new TypeError(`Adapter write action ${actionName} must be resource-serial.`);
  }
  if (effectKind !== "write" && requiresExpectedRevision) {
    throw new TypeError(`Adapter non-write action ${actionName} cannot require a revision.`);
  }
  return Object.freeze({
    description: manifestString(ownData(value, "description"), `${actionName} description`),
    inputSchema: schemaSnapshot(ownData(value, "inputSchema"), `${actionName} inputSchema`),
    outputSchema: schemaSnapshot(ownData(value, "outputSchema"), `${actionName} outputSchema`),
    effectKind,
    dryRunSemantics,
    requiredCapabilities: stringSet(
      ownData(value, "requiredCapabilities"),
      `${actionName} requiredCapabilities`,
    ),
    maxResultBytes: positiveResultLimit(
      ownData(value, "maxResultBytes"),
      `${actionName} maxResultBytes`,
    ),
    writeConcurrency: concurrency,
    adapterErrorCodes: stringSet(
      ownData(value, "adapterErrorCodes"),
      `${actionName} adapterErrorCodes`,
      ADAPTER_ERROR_CODE_PATTERN,
    ),
    requiresExpectedRevision,
    reconciliation,
  });
}

export function snapshotAdapter(adapter: GameAdapter): GameAdapter {
  if (adapter === null || typeof adapter !== "object") {
    throw new TypeError("Adapter must be an object.");
  }
  const id = manifestString(ownData(adapter, "id"), "adapter id", MANIFEST_NAME_PATTERN);
  const displayName = manifestString(ownData(adapter, "displayName"), "adapter displayName");
  const actionsValue = ownData(adapter, "actions");
  if (
    actionsValue === null ||
    typeof actionsValue !== "object" ||
    Object.getPrototypeOf(actionsValue) !== Object.prototype
  ) {
    throw new TypeError("Adapter actions must be a plain record.");
  }
  const actionEntries = Object.entries(actionsValue as Record<string, unknown>);
  if (actionEntries.length > 64) {
    throw new TypeError("Adapter actions must be a bounded record.");
  }
  const actions = Object.freeze(
    Object.fromEntries(
      actionEntries
        .map(
          ([name, definition]) =>
            [
              manifestString(name, "adapter action name", MANIFEST_NAME_PATTERN),
              snapshotAction(definition, name),
            ] as const,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  if (typeof adapter.observe !== "function") {
    throw new TypeError("Adapter observation method is invalid.");
  }
  const requiresRevision = Object.values(actions).some(
    (definition) => definition.requiresExpectedRevision,
  );
  if (actionEntries.length > 0 && typeof adapter.execute !== "function") {
    throw new TypeError("Adapter action execution method is required when actions exist.");
  }
  if (requiresRevision && typeof adapter.getStateRevision !== "function") {
    throw new TypeError("Adapter revision provider is required by a write action.");
  }
  return Object.freeze({
    id,
    displayName,
    observation: snapshotObservation(ownData(adapter, "observation")),
    actions,
    observe: adapter.observe.bind(adapter),
    ...(typeof adapter.getStateRevision === "function"
      ? { getStateRevision: adapter.getStateRevision.bind(adapter) }
      : {}),
    ...(typeof adapter.execute === "function" ? { execute: adapter.execute.bind(adapter) } : {}),
    ...(typeof adapter.health === "function" ? { health: adapter.health.bind(adapter) } : {}),
  });
}

export function describeAdapter(adapter: GameAdapter): AdapterDescription {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    observation: {
      description: adapter.observation.description,
      outputSchema: schemaJson(adapter.observation.outputSchema),
      effectKind: adapter.observation.effectKind,
      concurrency: adapter.observation.concurrency,
      requiredCapabilities: adapter.observation.requiredCapabilities,
      maxResultBytes: adapter.observation.maxResultBytes,
    },
    actions: Object.fromEntries(
      Object.entries(adapter.actions).map(([name, definition]) => [
        name,
        {
          description: definition.description,
          inputSchema: schemaJson(definition.inputSchema),
          outputSchema: schemaJson(definition.outputSchema),
          effectKind: definition.effectKind,
          dryRunSemantics: definition.dryRunSemantics,
          requiredCapabilities: definition.requiredCapabilities,
          maxResultBytes: definition.maxResultBytes,
          writeConcurrency: definition.writeConcurrency,
          adapterErrorCodes: definition.adapterErrorCodes,
          requiresExpectedRevision: definition.requiresExpectedRevision,
          reconciliation: definition.reconciliation,
        },
      ]),
    ),
  };
}
