import { Buffer } from "node:buffer";
import { z } from "zod";
import type { BridgeMode } from "./protocol.js";
import type { AdapterHealthStatus } from "./health.js";

export const ADAPTER_MAX_RESULT_BYTES = 32 * 1_024;
export const ADAPTER_MAX_SCHEMA_SCALAR_BYTES = 1_024;
export const ADAPTER_MAX_SCHEMA_SNAPSHOT_BYTES = 16 * 1_024;
export const ADAPTER_MAX_CATALOG_BYTES = 24 * 1_024;
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
  readonly jsonSchema: unknown;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: unknown }>
    | Readonly<{ success: false }>;
}

export interface AdapterObservationDefinition {
  description: string;
  outputSchema: AdapterSchema;
  effectKind: "read";
  concurrency: AdapterObservationConcurrency;
  requiredCapabilities: readonly string[];
  maxResultBytes: number;
}

export interface AdapterActionDefinition {
  description: string;
  inputSchema: AdapterSchema;
  outputSchema: AdapterSchema;
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

function captureOwnDataRecord(
  value: unknown,
  maxEntries = 256,
  requirePlainPrototype = true,
): ReadonlyMap<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (requirePlainPrototype && prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > maxEntries || keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const captured = new Map<string, unknown>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      captured.set(key, descriptor.value);
    }
    return captured;
  } catch {
    return undefined;
  }
}

function captureOwnDataArray(value: unknown, maxLength = 256): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maxLength
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
      )
    ) {
      return undefined;
    }
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      captured.push(descriptor.value);
    }
    return captured;
  } catch {
    return undefined;
  }
}

function stringSet(value: unknown, label: string, pattern = MANIFEST_NAME_PATTERN): readonly string[] {
  const captured = captureOwnDataArray(value, 64);
  if (captured === undefined) {
    throw new TypeError(`${label} must be a bounded string array.`);
  }
  const values = captured.map((entry) => manifestString(entry, label, pattern));
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} cannot contain duplicates.`);
  }
  return Object.freeze([...values].sort());
}

// Schemas are constructed from data by the host, never inspected as executable
// Zod objects during registration. The validator stays private to this module.
const definedSchemas = new WeakSet<object>();

function declarativeError(): never {
  throw new TypeError("Adapter schema must use the bounded declarative JSON Schema subset.");
}

function captureSchemaJson(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    if (++nodes > 2_048 || depth > 32) return declarativeError();
    if (typeof entry === "string") {
      const size = Buffer.byteLength(entry, "utf8");
      if (size > ADAPTER_MAX_SCHEMA_SCALAR_BYTES) return declarativeError();
      bytes += size;
      if (bytes > ADAPTER_MAX_SCHEMA_SNAPSHOT_BYTES) return declarativeError();
      return entry;
    }
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry) && !Object.is(entry, -0)) return entry;
    if (Array.isArray(entry)) {
      const captured = captureOwnDataArray(entry);
      if (captured === undefined) return declarativeError();
      return Object.freeze(captured.map((child) => visit(child, depth + 1)));
    }
    const captured = captureOwnDataRecord(entry);
    if (captured === undefined) return declarativeError();
    return Object.freeze(Object.fromEntries([...captured].map(([key, child]) => [
      visit(key, depth + 1) as string, visit(child, depth + 1),
    ])));
  };
  return visit(value, 0);
}

function validateSchemaJson(value: unknown): void {
  if (value === false) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) declarativeError();
  const schema = value as Record<string, unknown>;
  const common = ["$schema", "type", "const", "enum"];
  const keywords: Record<string, readonly string[]> = {
    string: ["minLength", "maxLength", "pattern"],
    number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
    integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
    boolean: [], null: [],
    object: ["properties", "required", "additionalProperties"],
    array: ["items", "minItems", "maxItems"],
  };
  if (Object.hasOwn(schema, "$schema") && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") declarativeError();
  if (Object.hasOwn(schema, "anyOf")) {
    if (Object.keys(schema).some((key) => key !== "$schema" && key !== "anyOf")) declarativeError();
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 2 || schema.anyOf.length > 64) declarativeError();
    schema.anyOf.forEach(validateSchemaJson);
    return;
  }
  if (typeof schema.type !== "string" || !Object.hasOwn(keywords, schema.type)) declarativeError();
  const allowed = [...common, ...keywords[schema.type]!];
  if (Object.keys(schema).some((key) => !allowed.includes(key))) declarativeError();
  // Zod's JSON importer treats literals as terminal nodes. Do not advertise
  // sibling constraints that such a validator would silently ignore.
  if (Object.hasOwn(schema, "const") || Object.hasOwn(schema, "enum")) {
    const literalKey = Object.hasOwn(schema, "const") ? "const" : "enum";
    if (Object.keys(schema).some((key) => !["$schema", "type", literalKey].includes(key))) declarativeError();
  }
  const literalMatches = (literal: unknown): boolean => {
    if (schema.type === "null") return literal === null;
    if (schema.type === "integer") return Number.isSafeInteger(literal);
    return ["string", "number", "boolean"].includes(schema.type as string) && typeof literal === schema.type;
  };
  if (Object.hasOwn(schema, "const") && !literalMatches(schema.const)) declarativeError();
  if (Object.hasOwn(schema, "enum") && (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 64 || !schema.enum.every(literalMatches))) declarativeError();
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (Object.hasOwn(schema, key) && (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0)) declarativeError();
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (Object.hasOwn(schema, key) && typeof schema[key] !== "number") declarativeError();
  }
  if (Object.hasOwn(schema, "pattern")) {
    if (typeof schema.pattern !== "string") declarativeError();
    try { new RegExp(schema.pattern); } catch { declarativeError(); }
  }
  if (schema.type === "array") validateSchemaJson(schema.items);
  if (schema.type === "object") {
    if (schema.additionalProperties !== false || schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) declarativeError();
    const properties = schema.properties as Record<string, unknown>;
    Object.values(properties).forEach(validateSchemaJson);
    if (Object.hasOwn(schema, "required")) {
      if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))) declarativeError();
    }
  }
}

/** Accept only bounded, closed JSON Schema data; no callbacks, references or coercion. */
export function defineAdapterSchema(source: unknown): AdapterSchema {
  const jsonSchema = captureSchemaJson(source);
  validateSchemaJson(jsonSchema);
  if (Buffer.byteLength(JSON.stringify(jsonSchema), "utf8") > ADAPTER_MAX_SCHEMA_SNAPSHOT_BYTES) declarativeError();
  const validator = z.fromJSONSchema(structuredClone(jsonSchema) as Parameters<typeof z.fromJSONSchema>[0]);
  const schema: AdapterSchema = Object.freeze({
    jsonSchema,
    safeParse: (candidate: unknown) => {
      const result = validator.safeParse(candidate);
      return result.success
        ? Object.freeze({ success: true as const, data: result.data })
        : Object.freeze({ success: false as const });
    },
  });
  definedSchemas.add(schema);
  return schema;
}

function schemaSnapshot(value: unknown, label: string): AdapterSchema {
  if (value === null || typeof value !== "object" || !definedSchemas.has(value)) {
    throw new TypeError(`${label} must be created with defineAdapterSchema using declarative JSON data.`);
  }
  return value as AdapterSchema;
}

function schemaJson(schema: AdapterSchema): unknown {
  return schemaSnapshot(schema, "schema").jsonSchema;
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
    requiredCapabilities: (() => {
      const capabilities = stringSet(
        ownData(value, "requiredCapabilities"),
        "observation requiredCapabilities",
      );
      if (capabilities.length === 0) {
        throw new TypeError("Adapter observation must require at least one capability.");
      }
      return capabilities;
    })(),
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
  if (effectKind !== "write" && concurrency.kind !== "none") {
    throw new TypeError(`Adapter non-write action ${actionName} must not claim write scheduling.`);
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
    requiredCapabilities: (() => {
      const capabilities = stringSet(
        ownData(value, "requiredCapabilities"),
        `${actionName} requiredCapabilities`,
      );
      if (capabilities.length === 0) {
        throw new TypeError(`Adapter action ${actionName} must require a capability.`);
      }
      return capabilities;
    })(),
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
  let healthMember: unknown;
  try {
    healthMember = adapter.health;
  } catch {
    throw new TypeError("Adapter health member could not be captured.");
  }
  if (healthMember !== undefined && typeof healthMember !== "function") {
    throw new TypeError("Adapter health member must be a function when defined.");
  }
  const snapshot = Object.freeze({
    id,
    displayName,
    observation: snapshotObservation(ownData(adapter, "observation")),
    actions,
    observe: adapter.observe.bind(adapter),
    ...(typeof adapter.getStateRevision === "function"
      ? { getStateRevision: adapter.getStateRevision.bind(adapter) }
      : {}),
    ...(typeof adapter.execute === "function" ? { execute: adapter.execute.bind(adapter) } : {}),
    ...(healthMember === undefined ? {} : { health: healthMember.bind(adapter) }),
  });
  if (
    Buffer.byteLength(JSON.stringify(describeAdapter(snapshot)), "utf8") >
    ADAPTER_MAX_CATALOG_BYTES
  ) {
    throw new TypeError("Adapter catalog exceeds its bounded byte limit.");
  }
  return snapshot;
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
