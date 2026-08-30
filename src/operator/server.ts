import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  constants,
  lstatSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeLocalControlPlane } from "../core/bridge.js";
import type { SafetyStatus } from "../core/safety-latch.js";
import {
  OPERATOR_MAX_DESCRIPTOR_BYTES,
  OPERATOR_MAX_FRAME_BYTES,
  OPERATOR_MAX_MESSAGE_BYTES,
  OPERATOR_PIPE_PREFIX,
  OPERATOR_PROTOCOL_VERSION,
  OPERATOR_TOKEN_BYTES,
  encodeOperatorFrame,
  operatorDescriptorSchema,
  operatorRequestSchema,
  type OperatorDescriptor,
  type OperatorErrorCode,
  type OperatorRequest,
  type OperatorResponse,
} from "./protocol.js";

export const OPERATOR_MAX_CONNECTIONS = 4;
export const OPERATOR_LISTEN_TIMEOUT_MS = 2_000;
export const OPERATOR_READ_TIMEOUT_MS = 1_000;
export const OPERATOR_HANDLER_TIMEOUT_MS = 1_000;
export const OPERATOR_CLOSE_TIMEOUT_MS = 1_000;

const RUNTIME_DIRECTORY_NAME = "xiaoqie-game-bridge";
const DESCRIPTOR_FILE_NAME = "operator-runtime.json";

export type OperatorStartupFailure =
  | "descriptor"
  | "listener"
  | "runtime-directory"
  | "unsupported-platform";

export class OperatorStartupError extends Error {
  constructor(readonly category: OperatorStartupFailure) {
    super("The local operator control plane could not start.");
    this.name = "OperatorStartupError";
  }
}

export interface OperatorServerOptions {
  maxConnections?: number;
  listenTimeoutMs?: number;
  readTimeoutMs?: number;
  handlerTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFatal?: () => void;
  testOnly?: { faultMode: "fixed-endpoint" };
}

interface RequiredOperatorServerOptions {
  maxConnections: number;
  listenTimeoutMs: number;
  readTimeoutMs: number;
  handlerTimeoutMs: number;
  closeTimeoutMs: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
  digest: string;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function fixedFailure(code: OperatorErrorCode): OperatorResponse {
  return {
    version: OPERATOR_PROTOCOL_VERSION,
    type: "result",
    ok: false,
    error: { code },
  };
}

function safetyStatus(value: SafetyStatus): SafetyStatus {
  return {
    stopped: value.stopped,
    inFlightWrites: value.inFlightWrites,
    maxInFlightWrites: value.maxInFlightWrites,
    stopGeneration: value.stopGeneration,
  };
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("bounded-operation-timeout")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function operatorRuntimeDirectory(): string {
  return join(homedir(), "AppData", "Local", RUNTIME_DIRECTORY_NAME);
}

export function operatorDescriptorPath(): string {
  return join(operatorRuntimeDirectory(), DESCRIPTOR_FILE_NAME);
}

export class LocalOperatorServer {
  readonly #control: BridgeLocalControlPlane;
  readonly #options: RequiredOperatorServerOptions;
  readonly #secret = randomBytes(OPERATOR_TOKEN_BYTES);
  readonly #connections = new Set<Socket>();
  readonly #onFatal: (() => void) | undefined;
  readonly #testOnly: OperatorServerOptions["testOnly"];
  #server: Server | undefined;
  #directoryCreated = false;
  #descriptorIdentity: FileIdentity | undefined;
  #started = false;
  #closing: Promise<void> | undefined;

  constructor(control: BridgeLocalControlPlane, options: OperatorServerOptions = {}) {
    this.#control = control;
    this.#onFatal = options.onFatal;
    this.#testOnly = options.testOnly;
    this.#options = {
      maxConnections: positiveInteger(
        options.maxConnections ?? OPERATOR_MAX_CONNECTIONS,
        "maxConnections",
      ),
      listenTimeoutMs: positiveInteger(
        options.listenTimeoutMs ?? OPERATOR_LISTEN_TIMEOUT_MS,
        "listenTimeoutMs",
      ),
      readTimeoutMs: positiveInteger(
        options.readTimeoutMs ?? OPERATOR_READ_TIMEOUT_MS,
        "readTimeoutMs",
      ),
      handlerTimeoutMs: positiveInteger(
        options.handlerTimeoutMs ?? OPERATOR_HANDLER_TIMEOUT_MS,
        "handlerTimeoutMs",
      ),
      closeTimeoutMs: positiveInteger(
        options.closeTimeoutMs ?? OPERATOR_CLOSE_TIMEOUT_MS,
        "closeTimeoutMs",
      ),
    };
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (process.platform !== "win32") {
      throw new OperatorStartupError("unsupported-platform");
    }

    try {
      await this.#prepareRuntimeDirectory();
    } catch {
      throw new OperatorStartupError("runtime-directory");
    }

    const endpoint = `${OPERATOR_PIPE_PREFIX}${
      this.#testOnly?.faultMode === "fixed-endpoint"
        ? "00000000000000000000000000000000"
        : randomBytes(16).toString("hex")
    }`;
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          const fail = () => reject(new OperatorStartupError("listener"));
          server.once("error", fail);
          server.listen(endpoint, () => {
            server.off("error", fail);
            resolve();
          });
        }),
        this.#options.listenTimeoutMs,
      );
    } catch {
      await this.#closeListener();
      await this.#cleanupRuntimeDirectory();
      this.#secret.fill(0);
      throw new OperatorStartupError("listener");
    }

    server.on("error", () => {
      void this.close().finally(() => this.#onFatal?.());
    });

    try {
      await this.#publishDescriptor(endpoint);
    } catch {
      await this.#closeListener();
      await this.#cleanupDescriptor();
      await this.#cleanupRuntimeDirectory();
      this.#secret.fill(0);
      throw new OperatorStartupError("descriptor");
    }
    this.#started = true;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = this.#close();
    return this.#closing;
  }

  cleanupRuntimeObjectsForProcessExit(): void {
    const identity = this.#descriptorIdentity;
    this.#descriptorIdentity = undefined;
    if (identity !== undefined) {
      const path = operatorDescriptorPath();
      try {
        const status = lstatSync(path);
        const bytes = readFileSync(path);
        const matches =
          status.dev === identity.dev &&
          status.ino === identity.ino &&
          status.birthtimeMs === identity.birthtimeMs &&
          digest(bytes) === identity.digest;
        bytes.fill(0);
        if (matches) unlinkSync(path);
      } catch {
        // Process-exit cleanup preserves any target that cannot be re-identified.
      }
    }
    this.#secret.fill(0);
    if (this.#directoryCreated) {
      this.#directoryCreated = false;
      try {
        rmdirSync(operatorRuntimeDirectory());
      } catch {
        // Only an empty directory created by this launch may be removed.
      }
    }
  }

  async #close(): Promise<void> {
    for (const socket of this.#connections) socket.destroy();
    await this.#closeListener();
    await this.#cleanupDescriptor();
    await this.#cleanupRuntimeDirectory();
    this.#secret.fill(0);
    this.#started = false;
  }

  async #prepareRuntimeDirectory(): Promise<void> {
    const directory = operatorRuntimeDirectory();
    try {
      await mkdir(directory, { mode: 0o700 });
      this.#directoryCreated = true;
      return;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("invalid-runtime-directory");
    }
  }

  async #publishDescriptor(endpoint: string): Promise<void> {
    const descriptor: OperatorDescriptor = operatorDescriptorSchema.parse({
      version: OPERATOR_PROTOCOL_VERSION,
      transport: "windows-named-pipe",
      endpoint,
      token: this.#secret.toString("base64url"),
    });
    const bytes = Buffer.from(JSON.stringify(descriptor), "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > OPERATOR_MAX_DESCRIPTOR_BYTES) {
      bytes.fill(0);
      throw new Error("invalid-descriptor-size");
    }
    const descriptorPath = operatorDescriptorPath();
    const temporaryPath = `${descriptorPath}.${randomBytes(12).toString("hex")}.tmp`;
    let temporaryCreated = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporaryPath, descriptorPath);
      const status = await lstat(descriptorPath);
      this.#descriptorIdentity = {
        dev: status.dev,
        ino: status.ino,
        birthtimeMs: status.birthtimeMs,
        digest: digest(bytes),
      };
    } finally {
      bytes.fill(0);
      if (temporaryCreated) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  #accept(socket: Socket): void {
    socket.on("error", () => undefined);
    if (this.#closing !== undefined || this.#connections.size >= this.#options.maxConnections) {
      this.#sendAndClose(socket, fixedFailure("CAPACITY"));
      return;
    }
    this.#connections.add(socket);
    socket.once("close", () => this.#connections.delete(socket));
    let buffer = Buffer.alloc(0);
    let settled = false;
    let framePending = false;
    let finalizeImmediate: NodeJS.Immediate | undefined;
    const readTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        this.#sendAndClose(socket, fixedFailure("TIMEOUT"));
      }
    }, this.#options.readTimeoutMs);

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (framePending) {
        settled = true;
        if (finalizeImmediate !== undefined) clearImmediate(finalizeImmediate);
        this.#sendAndClose(socket, fixedFailure("INVALID_REQUEST"));
        return;
      }
      const newline = chunk.indexOf(0x0a);
      const segment = newline < 0 ? chunk : chunk.subarray(0, newline);
      if (buffer.byteLength + segment.byteLength > OPERATOR_MAX_FRAME_BYTES) {
        settled = true;
        clearTimeout(readTimer);
        this.#sendAndClose(socket, fixedFailure("INVALID_REQUEST"));
        return;
      }
      buffer = Buffer.concat([buffer, segment]);
      if (newline < 0) return;
      clearTimeout(readTimer);
      const trailing = chunk.subarray(newline + 1);
      if (
        buffer.byteLength === 0 ||
        buffer.byteLength > OPERATOR_MAX_MESSAGE_BYTES ||
        trailing.byteLength > 0
      ) {
        settled = true;
        buffer.fill(0);
        this.#sendAndClose(socket, fixedFailure("INVALID_REQUEST"));
        return;
      }
      framePending = true;
      finalizeImmediate = setImmediate(() => {
        if (settled) return;
        settled = true;
        const frame = buffer;
        buffer = Buffer.alloc(0);
        socket.pause();
        void this.#handleFrame(frame).then(
          (response) => this.#sendAndClose(socket, response),
          () => this.#sendAndClose(socket, fixedFailure("INTERNAL_ERROR")),
        );
      });
    });

    socket.once("close", () => {
      clearTimeout(readTimer);
      if (finalizeImmediate !== undefined) clearImmediate(finalizeImmediate);
      buffer.fill(0);
    });
  }

  async #handleFrame(frame: Buffer): Promise<OperatorResponse> {
    let raw: unknown;
    try {
      raw = JSON.parse(frame.toString("utf8"));
    } catch {
      frame.fill(0);
      return fixedFailure("INVALID_REQUEST");
    }
    frame.fill(0);
    const parsed = operatorRequestSchema.safeParse(raw);
    if (!parsed.success) return fixedFailure("INVALID_REQUEST");
    if (!this.#authenticate(parsed.data.token)) {
      return fixedFailure("AUTHENTICATION_FAILED");
    }
    try {
      return await bounded(
        this.#execute(parsed.data),
        this.#options.handlerTimeoutMs,
      );
    } catch {
      return fixedFailure("TIMEOUT");
    }
  }

  #authenticate(token: string): boolean {
    const candidate = Buffer.from(token, "base64url");
    try {
      return (
        candidate.byteLength === this.#secret.byteLength &&
        timingSafeEqual(candidate, this.#secret)
      );
    } finally {
      candidate.fill(0);
    }
  }

  async #execute(request: OperatorRequest): Promise<OperatorResponse> {
    if (request.command === "status") {
      return {
        version: OPERATOR_PROTOCOL_VERSION,
        type: "result",
        ok: true,
        command: "status",
        status: this.#control.getSafetyStatus(),
      };
    }
    if (request.command === "stop") {
      const result = await this.#control.stopSafety();
      return {
        version: OPERATOR_PROTOCOL_VERSION,
        type: "result",
        ok: true,
        command: "stop",
        status: safetyStatus(result),
        alreadyStopped: result.alreadyStopped,
      };
    }
    const result = await this.#control.resumeSafety(request.generation);
    if (result.resumed) {
      return {
        version: OPERATOR_PROTOCOL_VERSION,
        type: "result",
        ok: true,
        command: "resume",
        status: safetyStatus(result),
      };
    }
    const codes = {
      "generation-mismatch": "GENERATION_MISMATCH",
      "not-stopped": "NOT_STOPPED",
      "writes-in-flight": "WRITES_IN_FLIGHT",
    } as const;
    return fixedFailure(codes[result.reason]);
  }

  #sendAndClose(socket: Socket, response: OperatorResponse): void {
    let frame: Buffer;
    try {
      frame = encodeOperatorFrame(response);
    } catch {
      frame = encodeOperatorFrame(fixedFailure("INTERNAL_ERROR"));
    }
    const timer = setTimeout(() => socket.destroy(), this.#options.closeTimeoutMs);
    socket.end(frame, () => {
      frame.fill(0);
    });
    socket.once("close", () => clearTimeout(timer));
  }

  async #closeListener(): Promise<void> {
    const server = this.#server;
    if (server === undefined || !server.listening) return;
    try {
      await bounded(
        new Promise<void>((resolve) => server.close(() => resolve())),
        this.#options.closeTimeoutMs,
      );
    } catch {
      for (const socket of this.#connections) socket.destroy();
    }
  }

  async #cleanupDescriptor(): Promise<void> {
    const identity = this.#descriptorIdentity;
    this.#descriptorIdentity = undefined;
    if (identity === undefined) return;
    const path = operatorDescriptorPath();
    try {
      await access(path, constants.F_OK);
      const [status, bytes] = await Promise.all([lstat(path), readFile(path)]);
      const matches =
        status.dev === identity.dev &&
        status.ino === identity.ino &&
        status.birthtimeMs === identity.birthtimeMs &&
        digest(bytes) === identity.digest;
      bytes.fill(0);
      if (matches) await unlink(path);
    } catch {
      // Exact cleanup is best-effort; never delete an object that failed identity checks.
    }
  }

  async #cleanupRuntimeDirectory(): Promise<void> {
    if (!this.#directoryCreated) return;
    this.#directoryCreated = false;
    await rmdir(operatorRuntimeDirectory()).catch(() => undefined);
  }
}

export async function startLocalOperatorServer(
  control: BridgeLocalControlPlane,
  options: OperatorServerOptions = {},
): Promise<LocalOperatorServer> {
  const server = new LocalOperatorServer(control, options);
  await server.start();
  return server;
}
