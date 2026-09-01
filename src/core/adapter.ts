import { z } from "zod";
import type { BridgeMode } from "./protocol.js";
import type { AdapterHealthStatus } from "./health.js";

export const ADAPTER_MAX_RESULT_BYTES = 32 * 1_024;
const ADAPTER_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MANIFEST_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;

export type AdapterEffectKind = "read" | "preview" | "write";
export type AdapterDryRunSemantics = "exact" | "best-effort" | "unsupported";
export type AdapterWriteConcurrency =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "resource-serial"; resourceKey: string }>;

export interface AdapterObservationDefinition {
  description: string;
  outputSchema: z.ZodType<unknown>;
  effectKind: "read";
  concurrency: "parallel";
  requiredCapabilities: readonly string[];
  maxResultBytes: number;
}

export interface AdapterActionDefinition {
  description: string;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
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
    concurrency: "parallel";
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
  getStateRevision(): Promise<number>;
  execute(
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
  constructor(readonly kind: "unavailable" | "outcome-unknown") {
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

function warmSchemaGraph(value: object, seen = new WeakSet<object>()): void {
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof z.ZodType) {
    try {
      value.safeParse(undefined);
    } catch {
      // A custom refinement may throw for the deliberately invalid warm-up
      // value; the schema remains eligible if JSON Schema conversion succeeds.
    }
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (
      "value" in descriptor &&
      descriptor.value !== null &&
      typeof descriptor.value === "object"
    ) {
      warmSchemaGraph(descriptor.value, seen);
    }
  }
}

function deepFreezeSchemaGraph<T extends object>(value: T, seen = new WeakSet<object>()): T {
  if (seen.has(value)) return value;
  seen.add(value);
  // RegExp.lastIndex is intentionally writable and Zod resets it before each
  // pattern check. Sealing preserves the immutable source/flags contract while
  // leaving that required engine cursor writable.
  if (value instanceof RegExp) return Object.seal(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (
      "value" in descriptor &&
      descriptor.value !== null &&
      typeof descriptor.value === "object"
    ) {
      deepFreezeSchemaGraph(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function cloneSchemaValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  if (typeof value === "function") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (value instanceof RegExp) {
    const cloned = new RegExp(value.source, value.flags);
    cloned.lastIndex = value.lastIndex;
    seen.set(value, cloned);
    return cloned;
  }
  if (Array.isArray(value)) {
    const cloned: unknown[] = [];
    seen.set(value, cloned);
    for (const entry of value) cloned.push(cloneSchemaValue(entry, seen));
    return cloned;
  }
  if (value instanceof Map) {
    const cloned = new Map<unknown, unknown>();
    seen.set(value, cloned);
    for (const [key, entry] of value) {
      cloned.set(cloneSchemaValue(key, seen), cloneSchemaValue(entry, seen));
    }
    return cloned;
  }
  if (value instanceof Set) {
    const cloned = new Set<unknown>();
    seen.set(value, cloned);
    for (const entry of value) cloned.add(cloneSchemaValue(entry, seen));
    return cloned;
  }
  if (value instanceof z.ZodType) {
    const clonedDefinition = cloneSchemaValue(value._def, seen);
    const cloned = value.clone(clonedDefinition as never);
    seen.set(value, cloned);
    return cloned;
  }
  const zodInternal = value as {
    _zod?: { def?: unknown };
    clone?: (definition: unknown) => unknown;
  };
  if (
    zodInternal._zod !== undefined &&
    zodInternal._zod.def !== undefined &&
    typeof zodInternal.clone === "function"
  ) {
    const clonedDefinition = cloneSchemaValue(zodInternal._zod.def, seen);
    const cloned = zodInternal.clone(clonedDefinition);
    seen.set(value, cloned);
    return cloned;
  }
  const cloned = Object.create(Object.getPrototypeOf(value)) as object;
  seen.set(value, cloned);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    Object.defineProperty(
      cloned,
      key,
      "value" in descriptor
        ? { ...descriptor, value: cloneSchemaValue(descriptor.value, seen) }
        : descriptor,
    );
  }
  return cloned;
}

function schemaSnapshot(value: unknown, label: string): z.ZodType<unknown> {
  if (!(value instanceof z.ZodType)) {
    throw new TypeError(`${label} must be a Zod schema.`);
  }
  let snapshot: z.ZodType<unknown>;
  try {
    snapshot = cloneSchemaValue(value) as z.ZodType<unknown>;
    JSON.stringify(z.toJSONSchema(snapshot));
    // Install Zod's lazy parsing methods throughout the graph before sealing.
    // The definition graph is independently cloned, so none of its nested
    // mutable objects are shared with adapter-owned schemas and refinements are
    // preserved rather than approximated through JSON Schema round-tripping.
    warmSchemaGraph(snapshot);
  } catch {
    throw new TypeError(`${label} cannot be represented as JSON Schema.`);
  }
  return deepFreezeSchemaGraph(snapshot);
}

function snapshotObservation(value: unknown): AdapterObservationDefinition {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Adapter observation contract is invalid.");
  }
  if (ownData(value, "effectKind") !== "read") {
    throw new TypeError("Adapter observation effect kind must be read.");
  }
  if (ownData(value, "concurrency") !== "parallel") {
    throw new TypeError("Adapter observation concurrency must be parallel.");
  }
  return Object.freeze({
    description: manifestString(ownData(value, "description"), "observation description"),
    outputSchema: schemaSnapshot(ownData(value, "outputSchema"), "observation outputSchema"),
    effectKind: "read",
    concurrency: "parallel",
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
  if (actionEntries.length < 1 || actionEntries.length > 64) {
    throw new TypeError("Adapter actions must be a non-empty bounded record.");
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
  if (
    typeof adapter.observe !== "function" ||
    typeof adapter.getStateRevision !== "function" ||
    typeof adapter.execute !== "function"
  ) {
    throw new TypeError("Adapter execution methods are invalid.");
  }
  return Object.freeze({
    id,
    displayName,
    observation: snapshotObservation(ownData(adapter, "observation")),
    actions,
    observe: adapter.observe.bind(adapter),
    getStateRevision: adapter.getStateRevision.bind(adapter),
    execute: adapter.execute.bind(adapter),
    ...(typeof adapter.health === "function" ? { health: adapter.health.bind(adapter) } : {}),
  });
}

export function describeAdapter(adapter: GameAdapter): AdapterDescription {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    observation: {
      description: adapter.observation.description,
      outputSchema: z.toJSONSchema(adapter.observation.outputSchema),
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
          inputSchema: z.toJSONSchema(definition.inputSchema),
          outputSchema: z.toJSONSchema(definition.outputSchema),
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
