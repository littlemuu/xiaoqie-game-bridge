import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  redactSensitive,
  safeIdentifierTag,
  type AuditEvent,
  type AuditSink,
  type AuditWriteReservation,
} from "../core/audit.js";
import { bridgeModeSchema, errorCodes, knownBridgeActions } from "../core/protocol.js";

export const AUDIT_LEDGER_FORMAT_VERSION = 1 as const;
export const AUDIT_LEDGER_MAX_RECORD_BYTES = 4 * 1_024;
export const AUDIT_LEDGER_MAX_PENDING_WRITES = 8;
export const AUDIT_LEDGER_MAX_SEGMENT_BYTES = 64 * 1_024;
export const AUDIT_LEDGER_MAX_SEGMENTS = 8;
export const AUDIT_LEDGER_SHUTDOWN_DRAIN_MS = 500;

const FRAME_PREFIX_BYTES = 9;
const ZERO_DIGEST = "0".repeat(64);
const SEGMENT_PATTERN = /^segment-(\d{4})\.audit$/;
const TAG_PATTERN = /^[a-f0-9]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_METADATA_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_METADATA_NODES = 128;
const MAX_METADATA_STRING_BYTES = 1_024;
const SENSITIVE_VALUE =
  /(?:bearer|password|passwd|secret|token|credential|api[-_]?key|(?:https?|wss?|tcp):\/\/|\\\\\.\\pipe\\|[A-Za-z]:\\|\/Users\/|\/home\/|stack\s*trace)/i;

export type AuditLedgerStatus = "ready" | "degraded" | "full" | "corrupt" | "closed";
export type AuditLedgerErrorCode =
  | "capacity"
  | "closed"
  | "corrupt"
  | "invalid-event"
  | "io"
  | "object-identity";

export interface AuditLedgerHealth {
  status: AuditLedgerStatus;
  outstandingWrites: number;
  segmentCount: number;
  currentSegment: number;
  nextSequence: number;
}

export interface AuditLedgerLimits {
  maxRecordBytes: number;
  maxPendingWrites: number;
  maxSegmentBytes: number;
  maxSegments: number;
  shutdownDrainMs: number;
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number | bigint;
}

interface PersistentAuditEvent {
  timestamp: string;
  callerTag?: string;
  requestIdTag?: string;
  sessionIdTag?: string;
  adapterIdTag?: string;
  action:
    | (typeof knownBridgeActions)[number]
    | "unregistered"
    | "safety.stop.local"
    | "safety.resume.local"
    | "safety.resume.authorization.local";
  actionTag?: string;
  mode: "dry-run" | "commit";
  decision: "allow" | "deny";
  errorCode?: (typeof errorCodes)[number];
  safetyStopped: boolean;
  idempotencyHit: boolean;
  metadata?: BoundedJson;
}

type BoundedJson = null | boolean | number | string | BoundedJson[] | { [key: string]: BoundedJson };

type LedgerPayload =
  | { kind: "event"; event: PersistentAuditEvent }
  | {
      kind: "recovery";
      reason: "torn-tail";
      sourceSegments: number[];
      confirmedSequence: number;
    };

export interface AuditLedgerRecord {
  formatVersion: typeof AUDIT_LEDGER_FORMAT_VERSION;
  sequence: number;
  previousDigest: string;
  payload: LedgerPayload;
  digest: string;
}

export interface DurableAuditLedgerOptions {
  testOnly?: {
    rootDirectory: string;
    limits?: Partial<AuditLedgerLimits>;
    beforeAppend?: () => void | Promise<void>;
    beforeSync?: () => void | Promise<void>;
  };
}

export class AuditLedgerError extends Error {
  readonly code: AuditLedgerErrorCode;

  constructor(code: AuditLedgerErrorCode) {
    super(`audit-ledger-${code}`);
    this.name = "AuditLedgerError";
    this.code = code;
  }
}

const actionSchema = z.enum([
  ...knownBridgeActions,
  "unregistered",
  "safety.stop.local",
  "safety.resume.local",
  "safety.resume.authorization.local",
]);
const tagSchema = z.string().regex(TAG_PATTERN);
const persistentEventSchema = z
  .object({
    timestamp: z.string().datetime({ offset: true }),
    callerTag: tagSchema.optional(),
    requestIdTag: tagSchema.optional(),
    sessionIdTag: tagSchema.optional(),
    adapterIdTag: tagSchema.optional(),
    action: actionSchema,
    actionTag: tagSchema.optional(),
    mode: bridgeModeSchema,
    decision: z.enum(["allow", "deny"]),
    errorCode: z.enum(errorCodes).optional(),
    safetyStopped: z.boolean(),
    idempotencyHit: z.boolean(),
    metadata: z.unknown().optional(),
  })
  .strict();
const recoveryPayloadSchema = z
  .object({
    kind: z.literal("recovery"),
    reason: z.literal("torn-tail"),
    sourceSegments: z.array(z.number().int().min(1).max(9_999)).min(1).max(8),
    confirmedSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const ledgerRecordSchema = z
  .object({
    formatVersion: z.literal(AUDIT_LEDGER_FORMAT_VERSION),
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    previousDigest: z.string().regex(DIGEST_PATTERN),
    payload: z.union([
      z.object({ kind: z.literal("event"), event: persistentEventSchema }).strict(),
      recoveryPayloadSchema,
    ]),
    digest: z.string().regex(DIGEST_PATTERN),
  })
  .strict();

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuditLedgerError("invalid-event");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  throw new AuditLedgerError("invalid-event");
}

function digestRecordBase(base: Omit<AuditLedgerRecord, "digest">): string {
  return createHash("sha256").update(stableStringify(base), "utf8").digest("hex");
}

interface MetadataBudget {
  nodes: number;
  stringBytes: number;
}

function sanitizeBoundedJson(
  value: unknown,
  depth = 0,
  budget: MetadataBudget = { nodes: 0, stringBytes: 0 },
): BoundedJson {
  if (depth > 4) throw new AuditLedgerError("invalid-event");
  budget.nodes += 1;
  if (budget.nodes > MAX_METADATA_NODES) throw new AuditLedgerError("invalid-event");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new AuditLedgerError("invalid-event");
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 256 || SENSITIVE_VALUE.test(value)) return "[REDACTED]";
    budget.stringBytes += Buffer.byteLength(value, "utf8");
    if (budget.stringBytes > MAX_METADATA_STRING_BYTES) {
      throw new AuditLedgerError("invalid-event");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 16) throw new AuditLedgerError("invalid-event");
    return value.map((child) => sanitizeBoundedJson(child, depth + 1, budget));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 16) throw new AuditLedgerError("invalid-event");
    const sanitized: Record<string, BoundedJson> = {};
    for (const [key, child] of entries) {
      if (!SAFE_METADATA_KEY.test(key)) throw new AuditLedgerError("invalid-event");
      sanitized[key] = sanitizeBoundedJson(child, depth + 1, budget);
    }
    return sanitized;
  }
  throw new AuditLedgerError("invalid-event");
}

function persistentEvent(event: AuditEvent): PersistentAuditEvent {
  const redacted = redactSensitive(event) as AuditEvent;
  const candidate = {
    timestamp: redacted.timestamp,
    ...(redacted.callerTag === undefined ? {} : { callerTag: redacted.callerTag }),
    ...(redacted.requestIdTag === undefined ? {} : { requestIdTag: redacted.requestIdTag }),
    ...(redacted.sessionIdTag === undefined ? {} : { sessionIdTag: redacted.sessionIdTag }),
    ...(redacted.adapterId === undefined && redacted.adapterIdTag === undefined
      ? {}
      : { adapterIdTag: redacted.adapterIdTag ?? safeIdentifierTag(redacted.adapterId)! }),
    action: redacted.action,
    ...(redacted.actionTag === undefined ? {} : { actionTag: redacted.actionTag }),
    mode: redacted.mode,
    decision: redacted.decision,
    ...(redacted.errorCode === undefined ? {} : { errorCode: redacted.errorCode }),
    safetyStopped: redacted.safetyStopped,
    idempotencyHit: redacted.idempotencyHit,
    ...(redacted.metadata === undefined
      ? {}
      : { metadata: sanitizeBoundedJson(redacted.metadata) }),
  };
  const parsed = persistentEventSchema.safeParse(candidate);
  if (!parsed.success) throw new AuditLedgerError("invalid-event");
  return parsed.data as PersistentAuditEvent;
}

function identity(status: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return { dev: status.dev, ino: status.ino, birthtimeMs: status.birthtimeMs };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function segmentName(index: number): string {
  return `segment-${index.toString().padStart(4, "0")}.audit`;
}

export function durableAuditLedgerDirectory(): string {
  return join(homedir(), "AppData", "Local", "xiaoqie-game-bridge-audit", "ledger");
}

function defaultLimits(testOnly: DurableAuditLedgerOptions["testOnly"]): AuditLedgerLimits {
  const limits: AuditLedgerLimits = {
    maxRecordBytes: AUDIT_LEDGER_MAX_RECORD_BYTES,
    maxPendingWrites: AUDIT_LEDGER_MAX_PENDING_WRITES,
    maxSegmentBytes: AUDIT_LEDGER_MAX_SEGMENT_BYTES,
    maxSegments: AUDIT_LEDGER_MAX_SEGMENTS,
    shutdownDrainMs: AUDIT_LEDGER_SHUTDOWN_DRAIN_MS,
    ...testOnly?.limits,
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("invalid ledger limit");
  }
  if (limits.maxRecordBytes > limits.maxSegmentBytes || limits.maxSegments > 9_999) {
    throw new RangeError("invalid ledger limit relationship");
  }
  return limits;
}

interface ParsedSegment {
  confirmedRecords: AuditLedgerRecord[];
  tornTail: boolean;
}

function parseSegment(
  bytes: Buffer,
  limits: AuditLedgerLimits,
  expectedSequence: number,
  expectedPreviousDigest: string,
): ParsedSegment {
  const records: AuditLedgerRecord[] = [];
  let offset = 0;
  let sequence = expectedSequence;
  let previousDigest = expectedPreviousDigest;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < FRAME_PREFIX_BYTES) return { confirmedRecords: records, tornTail: true };
    const prefix = bytes.subarray(offset, offset + FRAME_PREFIX_BYTES).toString("ascii");
    if (!/^[a-f0-9]{8}:$/.test(prefix)) throw new AuditLedgerError("corrupt");
    const payloadBytes = Number.parseInt(prefix.slice(0, 8), 16);
    if (payloadBytes <= 0 || payloadBytes + FRAME_PREFIX_BYTES + 1 > limits.maxRecordBytes) {
      throw new AuditLedgerError("corrupt");
    }
    const frameBytes = FRAME_PREFIX_BYTES + payloadBytes + 1;
    if (remaining < frameBytes) return { confirmedRecords: records, tornTail: true };
    if (bytes[offset + frameBytes - 1] !== 0x0a) throw new AuditLedgerError("corrupt");
    const encoded = bytes.subarray(offset + FRAME_PREFIX_BYTES, offset + frameBytes - 1);
    let raw: unknown;
    try {
      raw = JSON.parse(encoded.toString("utf8"));
    } catch {
      throw new AuditLedgerError("corrupt");
    }
    const parsed = ledgerRecordSchema.safeParse(raw);
    if (!parsed.success) throw new AuditLedgerError("corrupt");
    const record = parsed.data as AuditLedgerRecord;
    if (record.payload.kind === "event" && record.payload.event.metadata !== undefined) {
      let sanitized: BoundedJson;
      try {
        sanitized = sanitizeBoundedJson(record.payload.event.metadata);
      } catch {
        throw new AuditLedgerError("corrupt");
      }
      if (stableStringify(sanitized) !== stableStringify(record.payload.event.metadata)) {
        throw new AuditLedgerError("corrupt");
      }
    }
    if (record.sequence !== sequence || record.previousDigest !== previousDigest) {
      throw new AuditLedgerError("corrupt");
    }
    const base = {
      formatVersion: record.formatVersion,
      sequence: record.sequence,
      previousDigest: record.previousDigest,
      payload: record.payload,
    };
    if (record.digest !== digestRecordBase(base)) throw new AuditLedgerError("corrupt");
    if (encoded.toString("utf8") !== stableStringify(record)) {
      throw new AuditLedgerError("corrupt");
    }
    records.push(record);
    sequence += 1;
    previousDigest = record.digest;
    offset += frameBytes;
  }
  return { confirmedRecords: records, tornTail: false };
}

export class DurableAuditLedger implements AuditSink {
  readonly #rootDirectory: string;
  readonly #limits: AuditLedgerLimits;
  readonly #testOnly: DurableAuditLedgerOptions["testOnly"];
  #directoryIdentity!: FileIdentity;
  #segmentIdentity!: FileIdentity;
  #segmentHandle: FileHandle | undefined;
  #segmentSize = 0;
  #segmentCount = 0;
  #currentSegment = 0;
  #nextSequence = 1;
  #previousDigest = ZERO_DIGEST;
  #outstandingWrites = 0;
  readonly #reservationCancellations = new Set<() => void>();
  #tail: Promise<void> = Promise.resolve();
  #status: AuditLedgerStatus = "ready";
  #writeDisabled = false;
  #acceptingWrites = true;
  #closed = false;
  readonly #shutdownController = new AbortController();

  private constructor(options: DurableAuditLedgerOptions) {
    this.#testOnly = options.testOnly;
    this.#rootDirectory = options.testOnly?.rootDirectory ?? durableAuditLedgerDirectory();
    this.#limits = defaultLimits(options.testOnly);
  }

  static async open(options: DurableAuditLedgerOptions = {}): Promise<DurableAuditLedger> {
    const ledger = new DurableAuditLedger(options);
    try {
      await ledger.#initialize();
      return ledger;
    } catch (error) {
      ledger.#acceptingWrites = false;
      ledger.#closed = true;
      await ledger.#segmentHandle?.close().catch(() => undefined);
      ledger.#segmentHandle = undefined;
      throw error instanceof AuditLedgerError ? error : new AuditLedgerError("io");
    }
  }

  limits(): Readonly<AuditLedgerLimits> {
    return Object.freeze({ ...this.#limits });
  }

  health(): Readonly<AuditLedgerHealth> {
    return Object.freeze({
      status: this.#status,
      outstandingWrites: this.#outstandingWrites,
      segmentCount: this.#segmentCount,
      currentSegment: this.#currentSegment,
      nextSequence: this.#nextSequence,
    });
  }

  isWritable(): boolean {
    return (
      this.#acceptingWrites &&
      !this.#closed &&
      !this.#writeDisabled &&
      (this.#status === "ready" || this.#status === "degraded") &&
      this.#outstandingWrites < this.#limits.maxPendingWrites
    );
  }

  write(event: AuditEvent): Promise<void> {
    const reservation = this.reserveWrite();
    if (reservation === undefined) return Promise.reject(this.#admissionError());
    return Promise.resolve(reservation.write(event));
  }

  reserveWrite(): AuditWriteReservation | undefined {
    if (!this.isWritable()) return undefined;
    this.#outstandingWrites += 1;
    let active = true;
    const cancel = () => {
      if (!active) return;
      active = false;
      this.#reservationCancellations.delete(cancel);
      this.#outstandingWrites -= 1;
    };
    this.#reservationCancellations.add(cancel);
    return Object.freeze({
      write: (event: AuditEvent) => {
        if (!active) return Promise.reject(new AuditLedgerError("closed"));
        active = false;
        this.#reservationCancellations.delete(cancel);
        return this.#writeReserved(event);
      },
      release: cancel,
    });
  }

  #admissionError(): AuditLedgerError {
    if (!this.#acceptingWrites || this.#closed) return new AuditLedgerError("closed");
    if (this.#status === "full" || this.#outstandingWrites >= this.#limits.maxPendingWrites) {
      return new AuditLedgerError("capacity");
    }
    if (this.#writeDisabled) return new AuditLedgerError("io");
    return new AuditLedgerError("corrupt");
  }

  #writeReserved(event: AuditEvent): Promise<void> {
    let payload: LedgerPayload;
    try {
      payload = { kind: "event", event: persistentEvent(event) };
    } catch (error) {
      this.#outstandingWrites -= 1;
      return Promise.reject(
        error instanceof AuditLedgerError ? error : new AuditLedgerError("invalid-event"),
      );
    }
    const operation = this.#tail.then(() => this.#appendPayload(payload));
    this.#tail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.#outstandingWrites -= 1;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#acceptingWrites = false;
    for (const cancel of [...this.#reservationCancellations]) cancel();
    let drainTimer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      this.#tail.then(() => true),
      new Promise<false>((resolve) => {
        drainTimer = setTimeout(() => {
          this.#shutdownController.abort();
          resolve(false);
        }, this.#limits.shutdownDrainMs);
        drainTimer.unref();
      }),
    ]).finally(() => {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    });
    if (!drained) {
      await this.#tail.catch(() => undefined);
    }
    this.#closed = true;
    await this.#segmentHandle?.close().catch(() => undefined);
    this.#segmentHandle = undefined;
    this.#status = "closed";
  }

  async #initialize(): Promise<void> {
    await this.#prepareDirectory();
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    const segments: number[] = [];
    for (const entry of entries) {
      const match = SEGMENT_PATTERN.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        this.#status = "corrupt";
        throw new AuditLedgerError("corrupt");
      }
      segments.push(Number.parseInt(match[1]!, 10));
    }
    segments.sort((left, right) => left - right);
    if (segments.length > this.#limits.maxSegments) throw new AuditLedgerError("corrupt");
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== index + 1) throw new AuditLedgerError("corrupt");
    }
    if (segments.length === 0) {
      await this.#createSegment(1);
      return;
    }

    let sequence = 1;
    let previousDigest = ZERO_DIGEST;
    const unresolvedTorn: number[] = [];
    let sawRecovery = false;
    for (const segment of segments) {
      const bytes = await this.#readVerifiedSegment(segment);
      let parsed: ParsedSegment;
      try {
        parsed = parseSegment(bytes, this.#limits, sequence, previousDigest);
      } finally {
        bytes.fill(0);
      }
      const expectedRecovery = unresolvedTorn.length > 0;
      if (expectedRecovery && parsed.confirmedRecords.length > 0) {
        const firstPayload = parsed.confirmedRecords[0]!.payload;
        if (
          firstPayload.kind !== "recovery" ||
          stableStringify(firstPayload.sourceSegments) !== stableStringify(unresolvedTorn) ||
          firstPayload.confirmedSequence !== sequence - 1
        ) {
          throw new AuditLedgerError("corrupt");
        }
        unresolvedTorn.length = 0;
      }
      for (let recordIndex = 0; recordIndex < parsed.confirmedRecords.length; recordIndex += 1) {
        const record = parsed.confirmedRecords[recordIndex]!;
        if (record.payload.kind === "recovery") {
          if (recordIndex !== 0 || !expectedRecovery) {
            throw new AuditLedgerError("corrupt");
          }
          sawRecovery = true;
        }
        sequence = record.sequence + 1;
        previousDigest = record.digest;
      }
      if (parsed.tornTail) unresolvedTorn.push(segment);
    }

    this.#nextSequence = sequence;
    this.#previousDigest = previousDigest;
    this.#segmentCount = segments.length;
    if (unresolvedTorn.length > 0) {
      if (segments.length >= this.#limits.maxSegments) {
        this.#status = "full";
        throw new AuditLedgerError("capacity");
      }
      await this.#createSegment(segments.length + 1);
      await this.#appendPayload({
        kind: "recovery",
        reason: "torn-tail",
        sourceSegments: [...unresolvedTorn],
        confirmedSequence: this.#nextSequence - 1,
      });
      this.#status = "degraded";
      return;
    }

    await this.#openExistingSegment(segments.at(-1)!);
    this.#status = sawRecovery ? "degraded" : "ready";
  }

  async #prepareDirectory(): Promise<void> {
    if (this.#testOnly === undefined) {
      const productDirectories = [
        homedir(),
        join(homedir(), "AppData"),
        join(homedir(), "AppData", "Local"),
        dirname(this.#rootDirectory),
      ];
      for (const directory of productDirectories) await this.#ensureDirectory(directory);
    } else {
      await this.#ensureDirectory(dirname(this.#rootDirectory));
    }
    await this.#ensureDirectory(this.#rootDirectory);
    this.#directoryIdentity = identity(await lstat(this.#rootDirectory));
  }

  async #ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw new AuditLedgerError("io");
      }
    }
    const status = await lstat(path).catch(() => {
      throw new AuditLedgerError("io");
    });
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new AuditLedgerError("object-identity");
    }
  }

  async #verifyDirectoryIdentity(): Promise<void> {
    const status = await lstat(this.#rootDirectory).catch(() => {
      throw new AuditLedgerError("object-identity");
    });
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      !identitiesMatch(this.#directoryIdentity, identity(status))
    ) {
      throw new AuditLedgerError("object-identity");
    }
  }

  async #readVerifiedSegment(index: number): Promise<Buffer> {
    await this.#verifyDirectoryIdentity();
    const path = join(this.#rootDirectory, segmentName(index));
    const before = await lstat(path).catch(() => {
      throw new AuditLedgerError("object-identity");
    });
    if (!before.isFile() || before.isSymbolicLink() || before.size > this.#limits.maxSegmentBytes) {
      throw new AuditLedgerError("corrupt");
    }
    const handle = await open(path, "r").catch(() => {
      throw new AuditLedgerError("io");
    });
    try {
      const after = await handle.stat();
      if (!after.isFile() || !identitiesMatch(identity(before), identity(after))) {
        throw new AuditLedgerError("object-identity");
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== after.size || bytes.byteLength > this.#limits.maxSegmentBytes) {
        bytes.fill(0);
        throw new AuditLedgerError("object-identity");
      }
      return bytes;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #createSegment(index: number): Promise<void> {
    await this.#verifyDirectoryIdentity();
    const path = join(this.#rootDirectory, segmentName(index));
    const handle = await open(path, "wx", 0o600).catch(() => {
      throw new AuditLedgerError("object-identity");
    });
    let accepted = false;
    try {
      const status = await handle.stat();
      await this.#verifyDirectoryIdentity();
      if (!status.isFile()) throw new AuditLedgerError("object-identity");
      if (this.#segmentHandle !== undefined) {
        await this.#segmentHandle.close().catch(() => undefined);
      }
      this.#segmentHandle = handle;
      this.#segmentIdentity = identity(status);
      this.#segmentSize = 0;
      this.#currentSegment = index;
      this.#segmentCount = Math.max(this.#segmentCount, index);
      accepted = true;
    } catch (error) {
      throw error instanceof AuditLedgerError ? error : new AuditLedgerError("io");
    } finally {
      if (!accepted) await handle.close().catch(() => undefined);
    }
  }

  async #openExistingSegment(index: number): Promise<void> {
    await this.#verifyDirectoryIdentity();
    const path = join(this.#rootDirectory, segmentName(index));
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new AuditLedgerError("object-identity");
    const handle = await open(path, "a", 0o600).catch(() => {
      throw new AuditLedgerError("io");
    });
    let accepted = false;
    try {
      const after = await handle.stat();
      await this.#verifyDirectoryIdentity();
      if (!after.isFile() || !identitiesMatch(identity(before), identity(after))) {
        throw new AuditLedgerError("object-identity");
      }
      this.#segmentHandle = handle;
      this.#segmentIdentity = identity(after);
      this.#segmentSize = after.size;
      this.#currentSegment = index;
      this.#segmentCount = Math.max(this.#segmentCount, index);
      accepted = true;
    } catch (error) {
      throw error instanceof AuditLedgerError ? error : new AuditLedgerError("io");
    } finally {
      if (!accepted) await handle.close().catch(() => undefined);
    }
  }

  #encodePayload(payload: LedgerPayload): Buffer {
    const base: Omit<AuditLedgerRecord, "digest"> = {
      formatVersion: AUDIT_LEDGER_FORMAT_VERSION,
      sequence: this.#nextSequence,
      previousDigest: this.#previousDigest,
      payload,
    };
    const record: AuditLedgerRecord = { ...base, digest: digestRecordBase(base) };
    const encoded = Buffer.from(stableStringify(record), "utf8");
    const frameBytes = FRAME_PREFIX_BYTES + encoded.byteLength + 1;
    if (frameBytes > this.#limits.maxRecordBytes) {
      encoded.fill(0);
      throw new AuditLedgerError("invalid-event");
    }
    const prefix = Buffer.from(`${encoded.byteLength.toString(16).padStart(8, "0")}:`, "ascii");
    const frame = Buffer.concat([prefix, encoded, Buffer.from("\n")]);
    encoded.fill(0);
    return frame;
  }

  async #appendPayload(payload: LedgerPayload): Promise<void> {
    if (this.#closed) throw new AuditLedgerError("closed");
    if (this.#writeDisabled) throw new AuditLedgerError("io");
    if (this.#status !== "ready" && this.#status !== "degraded") {
      throw new AuditLedgerError(this.#status === "full" ? "capacity" : "corrupt");
    }
    const frame = this.#encodePayload(payload);
    try {
      if (this.#segmentSize + frame.byteLength > this.#limits.maxSegmentBytes) {
        if (this.#segmentCount >= this.#limits.maxSegments) {
          this.#status = "full";
          throw new AuditLedgerError("capacity");
        }
        await this.#createSegment(this.#segmentCount + 1);
      }
      await this.#verifyDirectoryIdentity();
      const path = join(this.#rootDirectory, segmentName(this.#currentSegment));
      const current = await lstat(path);
      const handle = this.#segmentHandle;
      if (handle === undefined) throw new AuditLedgerError("closed");
      const handleStatus = await handle.stat();
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        !identitiesMatch(this.#segmentIdentity, identity(current)) ||
        !identitiesMatch(this.#segmentIdentity, identity(handleStatus))
      ) {
        throw new AuditLedgerError("object-identity");
      }
      await this.#runTestHook(this.#testOnly?.beforeAppend);
      if (this.#shutdownController.signal.aborted) throw new AuditLedgerError("closed");
      const written = await handle.write(frame, 0, frame.byteLength, null);
      if (written.bytesWritten !== frame.byteLength) throw new AuditLedgerError("io");
      await this.#runTestHook(this.#testOnly?.beforeSync);
      if (this.#shutdownController.signal.aborted) throw new AuditLedgerError("closed");
      await handle.sync();
      this.#segmentSize += frame.byteLength;
      const parsed = parseSegment(
        frame,
        this.#limits,
        this.#nextSequence,
        this.#previousDigest,
      ).confirmedRecords[0]!;
      this.#nextSequence += 1;
      this.#previousDigest = parsed.digest;
    } catch (error) {
      if (error instanceof AuditLedgerError && error.code === "capacity") throw error;
      this.#status = "degraded";
      this.#writeDisabled = true;
      throw error instanceof AuditLedgerError ? error : new AuditLedgerError("io");
    } finally {
      frame.fill(0);
    }
  }

  async #runTestHook(hook: (() => void | Promise<void>) | undefined): Promise<void> {
    if (hook === undefined) return;
    const signal = this.#shutdownController.signal;
    if (signal.aborted) throw new AuditLedgerError("closed");
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new AuditLedgerError("closed"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(hook)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
