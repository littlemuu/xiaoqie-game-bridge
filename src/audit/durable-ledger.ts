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
export const AUDIT_LEDGER_MAX_CONFIRMATIONS = 2_048;
export const AUDIT_LEDGER_SHUTDOWN_DRAIN_MS = 500;

const FRAME_PREFIX_BYTES = 9;
const ZERO_DIGEST = "0".repeat(64);
const SEGMENT_PATTERN = /^segment-(\d{4})\.audit$/;
const CONFIRMATION_PATTERN = /^confirmation-(\d{16})\.audit$/;
const TAG_PATTERN = /^[a-f0-9]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CONFIRMATION_BYTES = 512;

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
}

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

interface AuditLedgerConfirmation {
  formatVersion: typeof AUDIT_LEDGER_FORMAT_VERSION;
  sequence: number;
  digest: string;
  segment: number;
  frameEnd: number;
}

export interface DurableAuditLedgerOptions {
  testOnly?: {
    rootDirectory: string;
    limits?: Partial<AuditLedgerLimits>;
    beforeAppend?: () => void | Promise<void>;
    beforeSync?: () => void | Promise<void>;
    sync?: (handle: FileHandle) => Promise<void>;
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
  })
  .strict();
const confirmationSchema = z
  .object({
    formatVersion: z.literal(AUDIT_LEDGER_FORMAT_VERSION),
    sequence: z.number().int().min(1).max(AUDIT_LEDGER_MAX_CONFIRMATIONS),
    digest: z.string().regex(DIGEST_PATTERN),
    segment: z.number().int().min(1).max(AUDIT_LEDGER_MAX_SEGMENTS),
    frameEnd: z.number().int().min(1).max(AUDIT_LEDGER_MAX_SEGMENT_BYTES),
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

function confirmationName(sequence: number): string {
  return `confirmation-${sequence.toString().padStart(16, "0")}.audit`;
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
  records: Array<{ record: AuditLedgerRecord; frameEnd: number }>;
  tornTail: boolean;
}

function parseSegment(
  bytes: Buffer,
  limits: AuditLedgerLimits,
  expectedSequence: number,
  expectedPreviousDigest: string,
): ParsedSegment {
  const records: Array<{ record: AuditLedgerRecord; frameEnd: number }> = [];
  let offset = 0;
  let sequence = expectedSequence;
  let previousDigest = expectedPreviousDigest;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < FRAME_PREFIX_BYTES) {
      return { records, tornTail: true };
    }
    const prefix = bytes.subarray(offset, offset + FRAME_PREFIX_BYTES).toString("ascii");
    if (!/^[a-f0-9]{8}:$/.test(prefix)) throw new AuditLedgerError("corrupt");
    const payloadBytes = Number.parseInt(prefix.slice(0, 8), 16);
    if (payloadBytes <= 0 || payloadBytes + FRAME_PREFIX_BYTES + 1 > limits.maxRecordBytes) {
      throw new AuditLedgerError("corrupt");
    }
    const frameBytes = FRAME_PREFIX_BYTES + payloadBytes + 1;
    if (remaining < frameBytes) {
      return { records, tornTail: true };
    }
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
    records.push({ record, frameEnd: offset + frameBytes });
    sequence += 1;
    previousDigest = record.digest;
    offset += frameBytes;
  }
  return { records, tornTail: false };
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
  #capacityReservations = 0;
  readonly #nativeIoHandles = new Set<FileHandle>();
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
      this.#outstandingWrites < this.#limits.maxPendingWrites &&
      this.#hasPhysicalCapacity(this.#capacityReservations + 1)
    );
  }

  write(event: AuditEvent): Promise<void> {
    const reservation = this.reserveWrite();
    if (reservation === undefined) return Promise.reject(this.#admissionError());
    return Promise.resolve(reservation.write(event));
  }

  reserveWrite(): AuditWriteReservation | undefined {
    if (!this.isWritable()) {
      if (
        this.#capacityReservations === 0 &&
        !this.#hasPhysicalCapacity(1) &&
        (this.#status === "ready" || this.#status === "degraded")
      ) {
        this.#status = "full";
      }
      return undefined;
    }
    this.#outstandingWrites += 1;
    this.#capacityReservations += 1;
    let active = true;
    const cancel = () => {
      if (!active) return;
      active = false;
      this.#reservationCancellations.delete(cancel);
      this.#outstandingWrites -= 1;
      this.#capacityReservations -= 1;
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
    if (
      this.#status === "full" ||
      this.#outstandingWrites >= this.#limits.maxPendingWrites ||
      !this.#hasPhysicalCapacity(this.#capacityReservations + 1)
    ) {
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
      this.#capacityReservations -= 1;
      return Promise.reject(
        error instanceof AuditLedgerError ? error : new AuditLedgerError("invalid-event"),
      );
    }
    const operation = this.#tail.then(() => this.#appendPayload(payload));
    this.#tail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.#outstandingWrites -= 1;
      this.#capacityReservations -= 1;
    });
  }

  #hasPhysicalCapacity(reservationCount: number): boolean {
    if (this.#nextSequence + reservationCount - 1 > AUDIT_LEDGER_MAX_CONFIRMATIONS) {
      return false;
    }
    let segment = this.#segmentCount;
    let bytes = this.#segmentSize;
    for (let index = 0; index < reservationCount; index += 1) {
      if (bytes + this.#limits.maxRecordBytes > this.#limits.maxSegmentBytes) {
        segment += 1;
        bytes = 0;
      }
      if (segment > this.#limits.maxSegments) return false;
      bytes += this.#limits.maxRecordBytes;
    }
    return true;
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
    const segmentHandle = this.#segmentHandle;
    if (segmentHandle !== undefined && (drained || !this.#nativeIoHandles.has(segmentHandle))) {
      await segmentHandle.close().catch(() => undefined);
    }
    this.#segmentHandle = undefined;
    this.#status = "closed";
  }

  async #initialize(): Promise<void> {
    await this.#prepareDirectory();
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    const segments: number[] = [];
    const confirmationSequences: number[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        this.#status = "corrupt";
        throw new AuditLedgerError("corrupt");
      }
      const segmentMatch = SEGMENT_PATTERN.exec(entry.name);
      if (segmentMatch !== null) {
        segments.push(Number.parseInt(segmentMatch[1]!, 10));
        continue;
      }
      const confirmationMatch = CONFIRMATION_PATTERN.exec(entry.name);
      if (confirmationMatch !== null) {
        confirmationSequences.push(Number.parseInt(confirmationMatch[1]!, 10));
        continue;
      }
      this.#status = "corrupt";
      throw new AuditLedgerError("corrupt");
    }
    segments.sort((left, right) => left - right);
    confirmationSequences.sort((left, right) => left - right);
    if (segments.length > this.#limits.maxSegments) throw new AuditLedgerError("corrupt");
    if (confirmationSequences.length > AUDIT_LEDGER_MAX_CONFIRMATIONS) {
      throw new AuditLedgerError("corrupt");
    }
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== index + 1) throw new AuditLedgerError("corrupt");
    }
    for (let index = 0; index < confirmationSequences.length; index += 1) {
      if (confirmationSequences[index] !== index + 1) throw new AuditLedgerError("corrupt");
    }
    if (segments.length === 0) {
      if (confirmationSequences.length > 0) throw new AuditLedgerError("corrupt");
      await this.#createSegment(1);
      return;
    }

    const confirmations = new Map<number, AuditLedgerConfirmation>();
    for (const confirmationSequence of confirmationSequences) {
      confirmations.set(
        confirmationSequence,
        await this.#readVerifiedConfirmation(confirmationSequence),
      );
    }

    let sequence = 1;
    let previousDigest = ZERO_DIGEST;
    const unresolvedTorn: number[] = [];
    const validatedConfirmations = new Set<number>();
    let sawRecovery = false;
    for (const segment of segments) {
      const bytes = await this.#readVerifiedSegment(segment);
      let parsed: ParsedSegment;
      try {
        parsed = parseSegment(bytes, this.#limits, sequence, previousDigest);
      } finally {
        bytes.fill(0);
      }
      const expectedRecoverySources = [...unresolvedTorn];
      const expectedRecovery = expectedRecoverySources.length > 0;
      if (expectedRecovery && parsed.records.length > 0) {
        const firstPayload = parsed.records[0]!.record.payload;
        if (
          firstPayload.kind !== "recovery" ||
          stableStringify(firstPayload.sourceSegments) !==
            stableStringify(expectedRecoverySources) ||
          firstPayload.confirmedSequence !== sequence - 1
        ) {
          throw new AuditLedgerError("corrupt");
        }
      }
      for (let recordIndex = 0; recordIndex < parsed.records.length; recordIndex += 1) {
        const { record, frameEnd } = parsed.records[recordIndex]!;
        if (record.payload.kind === "recovery") {
          if (recordIndex !== 0 || !expectedRecovery) {
            throw new AuditLedgerError("corrupt");
          }
        }
        if (validatedConfirmations.has(record.sequence)) {
          throw new AuditLedgerError("corrupt");
        }
        const confirmation = confirmations.get(record.sequence);
        const confirmedHere = confirmation?.segment === segment;
        if (!confirmedHere) {
          if (confirmation !== undefined && confirmation.segment < segment) {
            throw new AuditLedgerError("corrupt");
          }
          if (recordIndex !== parsed.records.length - 1) {
            throw new AuditLedgerError("corrupt");
          }
          if (!unresolvedTorn.includes(segment)) unresolvedTorn.push(segment);
          break;
        }
        if (confirmation.digest !== record.digest || confirmation.frameEnd !== frameEnd) {
          throw new AuditLedgerError("corrupt");
        }
        validatedConfirmations.add(record.sequence);
        if (record.payload.kind === "recovery") {
          unresolvedTorn.length = 0;
          sawRecovery = true;
        }
        sequence = record.sequence + 1;
        previousDigest = record.digest;
      }
      if (parsed.tornTail && !unresolvedTorn.includes(segment)) unresolvedTorn.push(segment);
    }

    if (validatedConfirmations.size !== confirmations.size) {
      throw new AuditLedgerError("corrupt");
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

  async #readVerifiedConfirmation(sequence: number): Promise<AuditLedgerConfirmation> {
    await this.#verifyDirectoryIdentity();
    const path = join(this.#rootDirectory, confirmationName(sequence));
    const before = await lstat(path).catch(() => {
      throw new AuditLedgerError("object-identity");
    });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0 ||
      before.size > MAX_CONFIRMATION_BYTES
    ) {
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
      try {
        if (bytes.byteLength !== after.size || bytes.at(-1) !== 0x0a) {
          throw new AuditLedgerError("corrupt");
        }
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
        } catch {
          throw new AuditLedgerError("corrupt");
        }
        const parsed = confirmationSchema.safeParse(raw);
        if (!parsed.success || parsed.data.sequence !== sequence) {
          throw new AuditLedgerError("corrupt");
        }
        if (`${stableStringify(parsed.data)}\n` !== bytes.toString("utf8")) {
          throw new AuditLedgerError("corrupt");
        }
        return parsed.data;
      } finally {
        bytes.fill(0);
      }
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
      await this.#syncWithShutdown(handle);
      if (this.#shutdownController.signal.aborted) throw new AuditLedgerError("closed");
      const frameEnd = this.#segmentSize + frame.byteLength;
      const parsed = parseSegment(
        frame,
        this.#limits,
        this.#nextSequence,
        this.#previousDigest,
      ).records[0]!.record;
      await this.#writeConfirmation({
        formatVersion: AUDIT_LEDGER_FORMAT_VERSION,
        sequence: parsed.sequence,
        digest: parsed.digest,
        segment: this.#currentSegment,
        frameEnd,
      });
      this.#segmentSize = frameEnd;
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

  async #writeConfirmation(confirmation: AuditLedgerConfirmation): Promise<void> {
    if (confirmation.sequence > AUDIT_LEDGER_MAX_CONFIRMATIONS) {
      this.#status = "full";
      throw new AuditLedgerError("capacity");
    }
    await this.#verifyDirectoryIdentity();
    const path = join(this.#rootDirectory, confirmationName(confirmation.sequence));
    const handle = await open(path, "wx", 0o600).catch(() => {
      throw new AuditLedgerError("object-identity");
    });
    let syncCompleted = false;
    const bytes = Buffer.from(`${stableStringify(confirmation)}\n`, "utf8");
    try {
      if (bytes.byteLength > MAX_CONFIRMATION_BYTES) {
        throw new AuditLedgerError("invalid-event");
      }
      const status = await handle.stat();
      await this.#verifyDirectoryIdentity();
      if (!status.isFile()) throw new AuditLedgerError("object-identity");
      const written = await handle.write(bytes, 0, bytes.byteLength, null);
      if (written.bytesWritten !== bytes.byteLength) throw new AuditLedgerError("io");
      await this.#syncWithShutdown(handle);
      syncCompleted = true;
    } finally {
      bytes.fill(0);
      if (syncCompleted || !this.#shutdownController.signal.aborted) {
        await handle.close().catch(() => undefined);
      }
    }
  }

  async #syncWithShutdown(handle: FileHandle): Promise<void> {
    const signal = this.#shutdownController.signal;
    if (signal.aborted) throw new AuditLedgerError("closed");
    this.#nativeIoHandles.add(handle);
    const nativeSync = Promise.resolve()
      .then(() => (this.#testOnly?.sync ?? ((target: FileHandle) => target.sync()))(handle))
      .finally(() => {
        this.#nativeIoHandles.delete(handle);
        if (this.#closed) void handle.close().catch(() => undefined);
      });
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new AuditLedgerError("closed"));
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      nativeSync.then(
        () => {
          cleanup();
          resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
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
