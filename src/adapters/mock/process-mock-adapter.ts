import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import {
  AdapterExecutionError,
  type AdapterActionDefinition,
  type GameAdapter,
} from "../../core/adapter.js";
import type { BridgeMode } from "../../core/protocol.js";
import {
  MockGameAdapter,
  mockMoveResultSchema,
  mockObservationResultSchema,
  mockPlaceBlockResultSchema,
} from "./mock-adapter.js";
import {
  ADAPTER_IPC_CALL_TIMEOUT_MS,
  ADAPTER_IPC_CLOSE_TIMEOUT_MS,
  ADAPTER_IPC_HANDSHAKE_TIMEOUT_MS,
  ADAPTER_IPC_MAX_FRAME_BYTES,
  ADAPTER_IPC_MAX_MESSAGE_BYTES,
  ADAPTER_IPC_MAX_PENDING_CALLS,
  ADAPTER_IPC_VERSION,
  type ContainmentAttestation,
  MOCK_ADAPTER_IDENTITY,
  adapterWorkerMessageSchema,
  encodeAdapterFrame,
  type AdapterWorkerMessage,
} from "./adapter-ipc.js";

export type AdapterRunnerFailure =
  | "capacity"
  | "closed"
  | "containment"
  | "handshake"
  | "protocol"
  | "timeout"
  | "worker-exit";

export class AdapterRunnerError extends Error {
  constructor(readonly category: AdapterRunnerFailure) {
    super("The isolated mock adapter could not complete the call.");
    this.name = "AdapterRunnerError";
  }
}

export type AdapterWorkerFaultMode =
  | "bad-handshake"
  | "ack-invalid"
  | "crash"
  | "duplicate-id"
  | "env-check"
  | "eof"
  | "hang"
  | "malformed"
  | "no-handshake"
  | "oversized"
  | "unknown-field"
  | "unknown-type"
  | "credential-result"
  | "wrong-result"
  | "wrong-id";

export interface ProcessMockAdapterOptions {
  handshakeTimeoutMs?: number;
  callTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxPendingCalls?: number;
  testOnly?: {
    faultMode: AdapterWorkerFaultMode;
    containmentFaultStage?: ContainmentFaultStage;
  };
}

export type ContainmentFaultStage =
  | "none"
  | "job"
  | "token"
  | "create"
  | "assign"
  | "attestation"
  | "resume";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: AdapterRunnerError | AdapterExecutionError): void;
  resultSchema: ZodType<unknown>;
  timer: NodeJS.Timeout;
}

const staticAdapter = new MockGameAdapter();
const DEFAULT_WORKER_PATH = fileURLToPath(
  import.meta.url.endsWith(".ts")
    ? new URL("../../../dist/src/adapters/mock/mock-worker.js", import.meta.url)
    : new URL("./mock-worker.js", import.meta.url),
);
const FIXED_FAULT_WORKER_PATH = fileURLToPath(
  import.meta.url.endsWith(".ts")
    ? new URL("../../../dist/tests/fixtures/fault-adapter-worker.js", import.meta.url)
    : new URL("../../../tests/fixtures/fault-adapter-worker.js", import.meta.url),
);
const NATIVE_DIRECTORY = fileURLToPath(
  import.meta.url.endsWith(".ts")
    ? new URL("../../../dist/native/", import.meta.url)
    : new URL("../../../native/", import.meta.url),
);
const PRODUCT_LAUNCHER_PATH = join(NATIVE_DIRECTORY, "xiaoqie-worker-launcher.exe");
const TEST_LAUNCHER_PATH = join(NATIVE_DIRECTORY, "xiaoqie-worker-test-launcher.exe");

function isContainmentLauncherExit(code: number | null): boolean {
  return code !== null && code >= 40 && code <= 47;
}

export function fixedWorkerLaunchSpec(options: ProcessMockAdapterOptions = {}) {
  const workerPath = options.testOnly === undefined
    ? DEFAULT_WORKER_PATH
    : FIXED_FAULT_WORKER_PATH;
  const launcherPath = options.testOnly === undefined
    ? PRODUCT_LAUNCHER_PATH
    : TEST_LAUNCHER_PATH;
  return Object.freeze({
    executable: launcherPath,
    argv: Object.freeze([
      process.execPath,
      workerPath,
      ...(options.testOnly === undefined
        ? []
        : [options.testOnly.faultMode, options.testOnly.containmentFaultStage ?? "none"]),
    ]),
    cwd: dirname(workerPath),
    env: Object.freeze({}),
    shell: false as const,
  });
}

export class ProcessMockAdapter implements GameAdapter {
  readonly id = staticAdapter.id;
  readonly displayName = staticAdapter.displayName;
  readonly observationCapability = staticAdapter.observationCapability;
  readonly actions: Readonly<Record<string, AdapterActionDefinition>> = staticAdapter.actions;

  readonly #options: Required<Omit<ProcessMockAdapterOptions, "testOnly">> &
    Pick<ProcessMockAdapterOptions, "testOnly">;
  readonly #pending = new Map<string, PendingCall>();
  #child: ChildProcess | undefined;
  #startup: Promise<void> | undefined;
  #startupResolve: (() => void) | undefined;
  #startupReject: ((error: AdapterRunnerError) => void) | undefined;
  #startupTimer: NodeJS.Timeout | undefined;
  #closePromise: Promise<void> | undefined;
  #closeResolve: (() => void) | undefined;
  #closeReject: ((error: AdapterRunnerError) => void) | undefined;
  #closeTimer: NodeJS.Timeout | undefined;
  #closeDeadlineTimer: NodeJS.Timeout | undefined;
  #closingFailure: AdapterRunnerFailure | undefined;
  #stdoutBuffer = Buffer.alloc(0);
  #sequence = 0;
  #state: "idle" | "starting" | "running" | "closing" | "closed" | "failed" = "idle";
  #exitObserved = false;
  #forcedClose = false;
  #shutdownAcknowledged = false;
  #terminationRequested = false;
  #containmentAttestation: ContainmentAttestation | undefined;

  constructor(options: ProcessMockAdapterOptions = {}) {
    this.#options = {
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? ADAPTER_IPC_HANDSHAKE_TIMEOUT_MS,
      callTimeoutMs: options.callTimeoutMs ?? ADAPTER_IPC_CALL_TIMEOUT_MS,
      closeTimeoutMs: options.closeTimeoutMs ?? ADAPTER_IPC_CLOSE_TIMEOUT_MS,
      maxPendingCalls: options.maxPendingCalls ?? ADAPTER_IPC_MAX_PENDING_CALLS,
      ...(options.testOnly === undefined ? {} : { testOnly: options.testOnly }),
    };
  }

  async start(): Promise<void> {
    if (this.#state === "running") return;
    if (this.#state === "starting") return this.#startup;
    if (this.#state !== "idle") throw new AdapterRunnerError("closed");

    if (process.platform !== "win32") throw new AdapterRunnerError("containment");
    this.#state = "starting";
    const spec = fixedWorkerLaunchSpec(this.#options);
    this.#startup = new Promise<void>((resolve, reject) => {
      this.#startupResolve = resolve;
      this.#startupReject = reject;
    });
    this.#startupTimer = setTimeout(
      () => this.#fail(this.#containmentAttestation === undefined ? "containment" : "handshake"),
      this.#options.handshakeTimeoutMs,
    );
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, spec.argv, {
        cwd: spec.cwd,
        env: spec.env,
        shell: spec.shell,
        windowsHide: true,
        // The fixed stdin pipe carries IPC and parent liveness. The native launcher
        // monitors an exact duplicate without consuming bytes, then passes only the
        // original stdin endpoint to the contained worker.
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      this.#fail("containment");
      return this.#startup;
    }
    this.#child = child;
    child.stdout!.on("data", (chunk: Buffer) => this.#consume(chunk));
    child.once("error", () => this.#fail("containment"));
    child.once("close", (code) => this.#onProcessClose(code));
    return this.#startup;
  }

  async observe(): Promise<unknown> {
    return this.#call({ operation: "observe" }, mockObservationResultSchema);
  }

  async execute(action: string, input: unknown, mode: BridgeMode): Promise<unknown> {
    const definition = this.actions[action];
    const parsed = definition?.inputSchema.safeParse(input);
    if (definition === undefined || parsed === undefined || !parsed.success) {
      throw new AdapterRunnerError("protocol");
    }
    const resultSchema = action === "move"
      ? mockMoveResultSchema
      : mockPlaceBlockResultSchema;
    return this.#call(
      { operation: "execute", action, input: parsed.data, mode },
      resultSchema,
    );
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "idle") {
      this.#state = "closed";
      return;
    }
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#closeResolve = resolve;
      this.#closeReject = reject;
    });
    const previousState = this.#state;
    this.#state = "closing";
    this.#closeDeadlineTimer = setTimeout(
      () => this.#failCloseWithoutExit(),
      Math.max(this.#options.closeTimeoutMs * 2, this.#options.closeTimeoutMs + 50),
    );

    if (previousState === "starting") {
      this.#settleStartup(new AdapterRunnerError("closed"));
      this.#failPending("closed");
      this.#requestForcedClose();
      return this.#closePromise;
    }
    if (this.#exitObserved) {
      this.#finishClose();
      return this.#closePromise;
    }
    if (this.#pending.size > 0 || previousState === "failed") {
      this.#failPending("closed");
      this.#requestForcedClose();
      return this.#closePromise;
    }
    this.#closeTimer = setTimeout(
      () => this.#requestForcedClose(),
      this.#options.closeTimeoutMs,
    );
    try {
      this.#write({ version: ADAPTER_IPC_VERSION, type: "shutdown" });
    } catch {
      this.#requestTermination();
    }
    return this.#closePromise;
  }

  get pendingCalls(): number {
    return this.#pending.size;
  }

  get containmentAttestation(): Readonly<ContainmentAttestation> | undefined {
    return this.#containmentAttestation === undefined
      ? undefined
      : Object.freeze({ ...this.#containmentAttestation });
  }

  async #call(call: Record<string, unknown>, resultSchema: ZodType<unknown>): Promise<unknown> {
    await this.start();
    if (this.#state !== "running") throw new AdapterRunnerError("closed");
    if (this.#pending.size >= this.#options.maxPendingCalls) {
      throw new AdapterRunnerError("capacity");
    }
    const callId = `call-${++this.#sequence}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(callId);
        reject(new AdapterRunnerError("timeout"));
        this.#fail("timeout");
      }, this.#options.callTimeoutMs);
      this.#pending.set(callId, { resolve, reject, resultSchema, timer });
      try {
        this.#write({
          version: ADAPTER_IPC_VERSION,
          type: "call",
          callId,
          ...call,
        });
      } catch {
        this.#fail("protocol");
      }
    });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child?.stdin === null || child?.stdin === undefined || child.stdin.destroyed) {
      throw new AdapterRunnerError("worker-exit");
    }
    const accepted = child.stdin.write(encodeAdapterFrame(message));
    if (!accepted) throw new AdapterRunnerError("capacity");
  }

  #consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const segment = chunk.subarray(offset, end);
      if (this.#stdoutBuffer.byteLength + segment.byteLength > ADAPTER_IPC_MAX_FRAME_BYTES) {
        this.#fail("protocol");
        return;
      }
      this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, segment]);
      if (newline < 0) return;
      if (this.#stdoutBuffer.byteLength === 0) {
        this.#fail("protocol");
        return;
      }
      const frame = this.#stdoutBuffer;
      this.#stdoutBuffer = Buffer.alloc(0);
      offset = newline + 1;
      if (frame.byteLength > ADAPTER_IPC_MAX_MESSAGE_BYTES) {
        this.#fail("protocol");
        return;
      }
      this.#handleFrame(frame);
      if (this.#state === "failed" || this.#state === "closed") return;
    }
  }

  #handleFrame(frame: Buffer): void {
    let raw: unknown;
    try {
      raw = JSON.parse(frame.toString("utf8"));
    } catch {
      this.#fail("protocol");
      return;
    }
    const parsed = adapterWorkerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const isContainmentFrame =
        typeof raw === "object" && raw !== null &&
        "type" in raw && raw.type === "containment-ready";
      this.#fail(
        this.#state === "starting"
          ? isContainmentFrame ? "containment" : "handshake"
          : "protocol",
      );
      return;
    }
    this.#handleMessage(parsed.data);
  }

  #handleMessage(message: AdapterWorkerMessage): void {
    if (message.type === "containment-ready") {
      if (this.#state !== "starting" || this.#containmentAttestation !== undefined) {
        this.#fail("containment");
        return;
      }
      this.#containmentAttestation = Object.freeze({ ...message.attestation });
      return;
    }
    if (message.type === "containment-fault") {
      this.#fail("containment");
      return;
    }
    if (message.type === "ready") {
      if (
        this.#state !== "starting" ||
        this.#containmentAttestation === undefined ||
        JSON.stringify(message.adapter) !== JSON.stringify(MOCK_ADAPTER_IDENTITY)
      ) {
        this.#fail(this.#containmentAttestation === undefined ? "containment" : "handshake");
        return;
      }
      this.#state = "running";
      this.#settleStartup();
      return;
    }
    if (message.type === "shutdown-complete") {
      if (this.#state !== "closing") {
        this.#fail("protocol");
        return;
      }
      this.#shutdownAcknowledged = true;
      this.#child?.stdin?.end();
      return;
    }
    if (this.#state !== "running") {
      this.#fail("protocol");
      return;
    }
    const pending = this.#pending.get(message.callId);
    if (pending === undefined) {
      this.#fail("protocol");
      return;
    }
    this.#pending.delete(message.callId);
    clearTimeout(pending.timer);
    if (message.ok) {
      const parsedResult = pending.resultSchema.safeParse(message.result);
      if (!parsedResult.success) {
        pending.reject(new AdapterRunnerError("protocol"));
        this.#fail("protocol");
        return;
      }
      pending.resolve(parsedResult.data);
      return;
    }
    if (message.error.code === "ADAPTER_FAILURE") {
      pending.reject(new AdapterRunnerError("protocol"));
      return;
    }
    const messages = {
      OUT_OF_BOUNDS: "The requested move leaves the mock world.",
      BLOCK_NOT_ALLOWED: "The requested block type is not allowed.",
      TARGET_OCCUPIED: "The mock-world target is occupied.",
    } as const;
    pending.reject(new AdapterExecutionError(message.error.code, messages[message.error.code]));
  }

  #onProcessClose(code: number | null): void {
    this.#exitObserved = true;
    if (this.#state === "closed") return;
    if (this.#state === "closing") {
      if (this.#closingFailure !== undefined) {
        this.#rejectClose(this.#closingFailure);
      } else if (this.#forcedClose || (this.#shutdownAcknowledged && code === 0)) {
        this.#finishClose();
      } else {
        this.#rejectClose("worker-exit");
      }
      return;
    }
    if (this.#state === "failed") return;
    this.#fail(
      isContainmentLauncherExit(code) || this.#containmentAttestation === undefined
        ? "containment"
        : "worker-exit",
    );
  }

  #fail(category: AdapterRunnerFailure): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    if (this.#state === "closing") {
      this.#closingFailure ??= category;
      this.#settleStartup(new AdapterRunnerError(category));
      this.#failPending(category);
      this.#requestTermination();
      return;
    }
    this.#state = "failed";
    this.#settleStartup(new AdapterRunnerError(category));
    this.#failPending(category);
    this.#requestTermination();
  }

  #failPending(category: AdapterRunnerFailure): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AdapterRunnerError(category));
    }
    this.#pending.clear();
  }

  #settleStartup(error?: AdapterRunnerError): void {
    if (this.#startupTimer !== undefined) {
      clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
    }
    if (error === undefined) {
      this.#startupResolve?.();
    } else {
      this.#startupReject?.(error);
    }
    this.#startupResolve = undefined;
    this.#startupReject = undefined;
  }

  #requestTermination(): void {
    if (this.#terminationRequested || this.#exitObserved) return;
    this.#terminationRequested = true;
    this.#child?.kill();
  }

  #requestForcedClose(): void {
    this.#forcedClose = true;
    this.#requestTermination();
  }

  #failCloseWithoutExit(): void {
    if (this.#state !== "closing" || this.#exitObserved) return;
    this.#rejectClose("worker-exit");
  }

  #rejectClose(category: AdapterRunnerFailure): void {
    if (this.#closeTimer !== undefined) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    if (this.#closeDeadlineTimer !== undefined) {
      clearTimeout(this.#closeDeadlineTimer);
      this.#closeDeadlineTimer = undefined;
    }
    this.#state = "failed";
    this.#settleStartup(new AdapterRunnerError(category));
    this.#failPending(category);
    this.#closeReject?.(new AdapterRunnerError(category));
    this.#closeResolve = undefined;
    this.#closeReject = undefined;
  }

  #finishClose(): void {
    if (this.#child !== undefined && !this.#exitObserved) return;
    if (this.#closeTimer !== undefined) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    if (this.#closeDeadlineTimer !== undefined) {
      clearTimeout(this.#closeDeadlineTimer);
      this.#closeDeadlineTimer = undefined;
    }
    this.#state = "closed";
    this.#closeResolve?.();
    this.#closeResolve = undefined;
    this.#closeReject = undefined;
  }
}
