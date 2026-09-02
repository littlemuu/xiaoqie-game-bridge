import { Buffer } from "node:buffer";
import { z } from "zod";
import type { BridgeMode } from "./protocol.js";
import type { AdapterHealthStatus } from "./health.js";

export const ADAPTER_MAX_RESULT_BYTES = 32 * 1_024;
export const ADAPTER_MAX_SCHEMA_SCALAR_BYTES = 1_024;
export const ADAPTER_MAX_SCHEMA_SNAPSHOT_BYTES = 16 * 1_024;
export const ADAPTER_MAX_CATALOG_BYTES = 128 * 1_024;
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

const BUILTIN_LENGTH_WHEN = (
  (
    (z.string().min(1) as unknown as {
      _zod: { def: { checks: Array<{ _zod: { def: { when: unknown } } }> } };
    })._zod.def.checks[0]!
  )._zod.def.when
);

function rejectsLosslessJsonNumber(value: unknown): boolean {
  return typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0));
}

type DeclarativeLiteral = string | number | boolean | null;
type DeclarativeCheck =
  | Readonly<{ kind: "min-length"; value: number }>
  | Readonly<{ kind: "max-length"; value: number }>
  | Readonly<{ kind: "greater-than"; value: number; inclusive: boolean }>
  | Readonly<{ kind: "less-than"; value: number; inclusive: boolean }>
  | Readonly<{ kind: "safeint" }>
  | Readonly<{ kind: "regex"; source: string }>;
type DeclarativeSchema =
  | Readonly<{ type: "string"; checks: readonly DeclarativeCheck[] }>
  | Readonly<{ type: "number"; checks: readonly DeclarativeCheck[] }>
  | Readonly<{ type: "boolean" }>
  | Readonly<{ type: "never" }>
  | Readonly<{ type: "literal"; values: readonly DeclarativeLiteral[] }>
  | Readonly<{ type: "enum"; entries: readonly (readonly [string, string | number])[] }>
  | Readonly<{ type: "optional"; innerType: DeclarativeSchema }>
  | Readonly<{ type: "union"; options: readonly DeclarativeSchema[] }>
  | Readonly<{ type: "array"; element: DeclarativeSchema; checks: readonly DeclarativeCheck[] }>
  | Readonly<{
      type: "object";
      shape: readonly (readonly [string, DeclarativeSchema])[];
    }>;

function declarativeError(label: string): never {
  throw new TypeError(`${label} must use the declarative schema subset.`);
}

function boundedSchemaString(value: string, label: string): string {
  if (Buffer.byteLength(value, "utf8") > ADAPTER_MAX_SCHEMA_SCALAR_BYTES) {
    throw new TypeError(`${label} exceeds bounded schema limits.`);
  }
  return value;
}

function hasExactKeys(record: ReadonlyMap<string, unknown>, expected: readonly string[]): boolean {
  return record.size === expected.length && expected.every((key) => record.has(key));
}

function functionSource(value: unknown): string | undefined {
  if (typeof value !== "function") return undefined;
  try {
    return Function.prototype.toString.call(value);
  } catch {
    return undefined;
  }
}

function schemaProcessorSource(schema: z.ZodType<unknown>): string {
  return Function.prototype.toString.call(
    (schema as unknown as { _zod: { processJSONSchema: () => unknown } })._zod
      .processJSONSchema,
  );
}

const BUILTIN_SCHEMA_PROCESSOR_SOURCES = Object.freeze({
  string: schemaProcessorSource(z.string()),
  number: schemaProcessorSource(z.number()),
  boolean: schemaProcessorSource(z.boolean()),
  never: schemaProcessorSource(z.never()),
  literal: schemaProcessorSource(z.literal("baseline")),
  enum: schemaProcessorSource(z.enum(["baseline"])),
  optional: schemaProcessorSource(z.string().optional()),
  union: schemaProcessorSource(z.union([z.string(), z.number()])),
  array: schemaProcessorSource(z.array(z.string())),
  object: schemaProcessorSource(z.object({}).strict()),
});

const BUILTIN_SAFEINT_PROCESSOR_SOURCE = Function.prototype.toString.call(
  (
    (z.number().int() as unknown as {
      _zod: { def: { checks: Array<{ _zod: { processJSONSchema: () => unknown } }> } };
    })._zod.def.checks[0]!
  )._zod.processJSONSchema,
);

const BUILTIN_OBJECT_SHAPE_GETTER_SOURCE = functionSource(
  Object.getOwnPropertyDescriptor(
    (z.object({}).strict() as unknown as { _zod: { def: object } })._zod.def,
    "shape",
  )?.get,
)!;

function captureSchemaDefinition(
  value: unknown,
  label: string,
): ReadonlyMap<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return declarativeError(label);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return declarativeError(label);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 16 || keys.some((key) => typeof key !== "string")) {
      return declarativeError(label);
    }
    const captured = new Map<string, unknown>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return declarativeError(label);
      if ("value" in descriptor) {
        captured.set(key, descriptor.value);
        continue;
      }
      if (
        key !== "shape" ||
        descriptor.set !== undefined ||
        functionSource(descriptor.get) !== BUILTIN_OBJECT_SHAPE_GETTER_SOURCE
      ) {
        return declarativeError(label);
      }
      captured.set(key, Reflect.apply(descriptor.get!, value, []));
    }
    return captured;
  } catch {
    return declarativeError(label);
  }
}

function captureSchemaParts(
  value: unknown,
  label: string,
): Readonly<{
  internal: ReadonlyMap<string, unknown>;
  definition: ReadonlyMap<string, unknown>;
}> {
  if (value === null || typeof value !== "object") declarativeError(label);
  let internalValue: unknown;
  try {
    const internalDescriptor = Object.getOwnPropertyDescriptor(value, "_zod");
    if (internalDescriptor === undefined || !("value" in internalDescriptor)) {
      declarativeError(label);
    }
    internalValue = internalDescriptor.value;
  } catch {
    declarativeError(label);
  }
  const internal = captureOwnDataRecord(internalValue, 32, false);
  if (internal === undefined) {
    declarativeError(label);
  }
  const definition = captureSchemaDefinition(internal.get("def"), label);
  return Object.freeze({ internal, definition });
}

function requireTrustedSchemaEmitterChain(
  firstInternal: ReadonlyMap<string, unknown>,
  expectedType: keyof typeof BUILTIN_SCHEMA_PROCESSOR_SOURCES,
  label: string,
): void {
  const seen = new WeakSet<object>();
  let internal = firstInternal;
  while (true) {
    if (
      internal.has("toJSONSchema") ||
      functionSource(internal.get("processJSONSchema")) !==
        BUILTIN_SCHEMA_PROCESSOR_SOURCES[expectedType]
    ) {
      declarativeError(label);
    }
    if (!internal.has("parent")) return;
    const parent = internal.get("parent");
    if (parent === null || typeof parent !== "object" || seen.has(parent)) {
      declarativeError(label);
    }
    seen.add(parent);
    const captured = captureSchemaParts(parent, label);
    if (captured.definition.get("type") !== expectedType) declarativeError(label);
    internal = captured.internal;
  }
}

function captureRegexSource(value: unknown, label: string): string {
  if (!(value instanceof RegExp)) declarativeError(label);
  try {
    const source = Reflect.apply(
      Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!.get!,
      value,
      [],
    ) as string;
    const flags = Reflect.apply(
      Object.getOwnPropertyDescriptor(RegExp.prototype, "flags")!.get!,
      value,
      [],
    ) as string;
    if (flags !== "") declarativeError(label);
    return boundedSchemaString(source, label);
  } catch {
    return declarativeError(label);
  }
}

function captureDeclarativeCheck(value: unknown, label: string): DeclarativeCheck {
  const { internal, definition } = captureSchemaParts(value, label);
  if (internal.has("toJSONSchema") || internal.has("parent")) declarativeError(label);
  const check = definition.get("check");
  if (check !== "number_format" && internal.has("processJSONSchema")) {
    declarativeError(label);
  }
  switch (check) {
    case "min_length": {
      const minimum = definition.get("minimum");
      if (
        !hasExactKeys(definition, ["check", "minimum", "when"]) ||
        !Number.isSafeInteger(minimum) ||
        (minimum as number) < 0 ||
        definition.get("when") !== BUILTIN_LENGTH_WHEN
      ) {
        declarativeError(label);
      }
      return Object.freeze({ kind: "min-length", value: minimum as number });
    }
    case "max_length": {
      const maximum = definition.get("maximum");
      if (
        !hasExactKeys(definition, ["check", "maximum", "when"]) ||
        !Number.isSafeInteger(maximum) ||
        (maximum as number) < 0 ||
        definition.get("when") !== BUILTIN_LENGTH_WHEN
      ) {
        declarativeError(label);
      }
      return Object.freeze({ kind: "max-length", value: maximum as number });
    }
    case "greater_than":
    case "less_than": {
      const numericValue = definition.get("value");
      const inclusive = definition.get("inclusive");
      if (
        !hasExactKeys(definition, ["check", "value", "inclusive"]) ||
        typeof numericValue !== "number" ||
        rejectsLosslessJsonNumber(numericValue) ||
        typeof inclusive !== "boolean"
      ) {
        declarativeError(label);
      }
      return Object.freeze({
        kind: check === "greater_than" ? "greater-than" : "less-than",
        value: numericValue,
        inclusive,
      });
    }
    case "number_format":
      if (
        !hasExactKeys(definition, ["type", "check", "abort", "format"]) ||
        definition.get("type") !== "number" ||
        definition.get("abort") !== false ||
        definition.get("format") !== "safeint" ||
        functionSource(internal.get("processJSONSchema")) !==
          BUILTIN_SAFEINT_PROCESSOR_SOURCE
      ) {
        declarativeError(label);
      }
      return Object.freeze({ kind: "safeint" });
    case "string_format":
      if (
        !hasExactKeys(definition, ["check", "format", "pattern"]) ||
        definition.get("format") !== "regex"
      ) {
        declarativeError(label);
      }
      return Object.freeze({
        kind: "regex",
        source: captureRegexSource(definition.get("pattern"), label),
      });
    default:
      return declarativeError(label);
  }
}

function captureDeclarativeSchema(value: unknown, label: string): DeclarativeSchema {
  const active = new WeakSet<object>();
  let nodeCount = 0;
  const visit = (schema: unknown): DeclarativeSchema => {
    if (schema === null || typeof schema !== "object" || active.has(schema)) {
      return declarativeError(label);
    }
    nodeCount += 1;
    if (nodeCount > 256) return declarativeError(label);
    active.add(schema);
    try {
      const { internal, definition } = captureSchemaParts(schema, label);
      const type = definition.get("type");
      if (typeof type !== "string" || !(type in BUILTIN_SCHEMA_PROCESSOR_SOURCES)) {
        return declarativeError(label);
      }
      requireTrustedSchemaEmitterChain(
        internal,
        type as keyof typeof BUILTIN_SCHEMA_PROCESSOR_SOURCES,
        label,
      );
      const checks = (allowed: readonly DeclarativeCheck["kind"][]): readonly DeclarativeCheck[] => {
        if (!definition.has("checks")) return Object.freeze([]);
        const captured = captureOwnDataArray(definition.get("checks"), 64);
        if (captured === undefined) return declarativeError(label);
        const result = captured.map((entry) => captureDeclarativeCheck(entry, label));
        if (result.some((entry) => !allowed.includes(entry.kind))) {
          return declarativeError(label);
        }
        return Object.freeze(result);
      };
      switch (type) {
        case "string":
          if (!hasExactKeys(definition, definition.has("checks") ? ["type", "checks"] : ["type"])) {
            return declarativeError(label);
          }
          return Object.freeze({
            type,
            checks: checks(["min-length", "max-length", "regex"]),
          });
        case "number":
          if (!hasExactKeys(definition, definition.has("checks") ? ["type", "checks"] : ["type"])) {
            return declarativeError(label);
          }
          return Object.freeze({
            type,
            checks: checks(["greater-than", "less-than", "safeint"]),
          });
        case "boolean":
        case "never":
          if (!hasExactKeys(definition, ["type"])) return declarativeError(label);
          return Object.freeze({ type });
        case "literal": {
          if (!hasExactKeys(definition, ["type", "values"])) return declarativeError(label);
          const values = captureOwnDataArray(definition.get("values"), 64);
          if (
            values === undefined ||
            values.length < 1 ||
            values.some(
              (entry) =>
                (entry !== null &&
                  typeof entry !== "string" &&
                  typeof entry !== "number" &&
                  typeof entry !== "boolean") ||
                rejectsLosslessJsonNumber(entry),
            )
          ) {
            return declarativeError(label);
          }
          return Object.freeze({
            type,
            values: Object.freeze(
              values.map((entry) =>
                typeof entry === "string" ? boundedSchemaString(entry, label) : entry,
              ) as DeclarativeLiteral[],
            ),
          });
        }
        case "enum": {
          if (!hasExactKeys(definition, ["type", "entries"])) return declarativeError(label);
          const entries = captureOwnDataRecord(definition.get("entries"), 256);
          if (entries === undefined || entries.size < 1) return declarativeError(label);
          const capturedEntries: Array<readonly [string, string | number]> = [];
          for (const [key, entry] of entries) {
            if (
              (typeof entry !== "string" && typeof entry !== "number") ||
              rejectsLosslessJsonNumber(entry)
            ) {
              return declarativeError(label);
            }
            capturedEntries.push(
              Object.freeze([
                boundedSchemaString(key, label),
                typeof entry === "string" ? boundedSchemaString(entry, label) : entry,
              ] as const),
            );
          }
          return Object.freeze({ type, entries: Object.freeze(capturedEntries) });
        }
        case "optional":
          if (!hasExactKeys(definition, ["type", "innerType"])) return declarativeError(label);
          return Object.freeze({ type, innerType: visit(definition.get("innerType")) });
        case "union": {
          if (!hasExactKeys(definition, ["type", "options"])) return declarativeError(label);
          const options = captureOwnDataArray(definition.get("options"), 64);
          if (options === undefined || options.length < 1) return declarativeError(label);
          return Object.freeze({ type, options: Object.freeze(options.map(visit)) });
        }
        case "array":
          if (!hasExactKeys(
            definition,
            definition.has("checks") ? ["type", "element", "checks"] : ["type", "element"],
          )) {
            return declarativeError(label);
          }
          return Object.freeze({
            type,
            element: visit(definition.get("element")),
            checks: checks(["min-length", "max-length"]),
          });
        case "object": {
          if (!hasExactKeys(definition, ["type", "shape", "catchall"])) {
            return declarativeError(label);
          }
          const catchall = visit(definition.get("catchall"));
          if (catchall.type !== "never") return declarativeError(label);
          const shape = captureOwnDataRecord(definition.get("shape"), 256);
          if (shape === undefined) return declarativeError(label);
          const capturedShape = [...shape].map(([key, child]) =>
            Object.freeze([boundedSchemaString(key, label), visit(child)] as const),
          );
          return Object.freeze({ type, shape: Object.freeze(capturedShape) });
        }
        default:
          return declarativeError(label);
      }
    } finally {
      active.delete(schema);
    }
  };
  return visit(value);
}

function buildDeclarativeSchema(schema: DeclarativeSchema): z.ZodType<unknown> {
  switch (schema.type) {
    case "string": {
      let built = z.string();
      for (const check of schema.checks) {
        if (check.kind === "min-length") built = built.min(check.value);
        else if (check.kind === "max-length") built = built.max(check.value);
        else if (check.kind === "regex") built = built.regex(new RegExp(check.source));
      }
      return built;
    }
    case "number": {
      let built = z.number();
      for (const check of schema.checks) {
        if (check.kind === "greater-than") {
          built = check.inclusive ? built.gte(check.value) : built.gt(check.value);
        } else if (check.kind === "less-than") {
          built = check.inclusive ? built.lte(check.value) : built.lt(check.value);
        } else if (check.kind === "safeint") {
          built = built.int();
        }
      }
      return built;
    }
    case "boolean":
      return z.boolean();
    case "never":
      return z.never();
    case "literal":
      return z.literal(
        schema.values as readonly [DeclarativeLiteral, ...DeclarativeLiteral[]],
      );
    case "enum":
      return z.enum(Object.fromEntries(schema.entries) as never);
    case "optional":
      return buildDeclarativeSchema(schema.innerType).optional();
    case "union":
      return z.union(
        schema.options.map(buildDeclarativeSchema) as [
          z.ZodType<unknown>,
          ...z.ZodType<unknown>[],
        ],
      );
    case "array": {
      let built = z.array(buildDeclarativeSchema(schema.element));
      for (const check of schema.checks) {
        if (check.kind === "min-length") built = built.min(check.value);
        else if (check.kind === "max-length") built = built.max(check.value);
      }
      return built;
    }
    case "object":
      return z.object(
        Object.fromEntries(
          schema.shape.map(([key, child]) => [key, buildDeclarativeSchema(child)]),
        ),
      ).strict();
  }
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
    const captured = captureDeclarativeSchema(value, label);
    const trustedSchema = buildDeclarativeSchema(captured);
    const encoded = JSON.stringify(
      z.toJSONSchema(trustedSchema, { metadata: z.registry() }),
    );
    if (Buffer.byteLength(encoded, "utf8") > ADAPTER_MAX_SCHEMA_SNAPSHOT_BYTES) {
      throw new TypeError(`${label} exceeds bounded schema limits.`);
    }
    const jsonSchema = deepFreezeJson(JSON.parse(encoded) as unknown);
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
    if (
      error instanceof TypeError &&
      /declarative schema subset|bounded schema limits/u.test(error.message)
    ) {
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
    ...(typeof adapter.health === "function" ? { health: adapter.health.bind(adapter) } : {}),
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
