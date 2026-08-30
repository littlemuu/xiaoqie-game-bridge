import { lstat, open } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import {
  OPERATOR_MAX_DESCRIPTOR_BYTES,
  OPERATOR_MAX_FRAME_BYTES,
  OPERATOR_MAX_MESSAGE_BYTES,
  OPERATOR_PROTOCOL_VERSION,
  encodeOperatorFrame,
  operatorDescriptorSchema,
  operatorResponseSchema,
  type OperatorResponse,
} from "./protocol.js";
import { operatorDescriptorPath } from "./server.js";

export const OPERATOR_CLIENT_CONNECT_TIMEOUT_MS = 1_000;
export const OPERATOR_CLIENT_RESPONSE_TIMEOUT_MS = 2_000;

export type OperatorCommand =
  | { command: "status" }
  | { command: "stop" }
  | { command: "resume"; generation: number };

export type OperatorClientFailure =
  | "not-running"
  | "protocol"
  | "timeout";

export class OperatorClientError extends Error {
  constructor(readonly category: OperatorClientFailure) {
    super("The local operator command could not complete.");
    this.name = "OperatorClientError";
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function loadDescriptor() {
  const path = operatorDescriptorPath();
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new OperatorClientError("protocol");
    }
    handle = await open(path, "r");
    const status = await handle.stat();
    if (
      status.dev !== before.dev ||
      status.ino !== before.ino ||
      status.size <= 0 ||
      status.size > OPERATOR_MAX_DESCRIPTOR_BYTES
    ) {
      throw new OperatorClientError("protocol");
    }
    const bytes = await handle.readFile();
    try {
      const parsed = operatorDescriptorSchema.safeParse(
        JSON.parse(bytes.toString("utf8")),
      );
      if (!parsed.success) throw new OperatorClientError("protocol");
      return parsed.data;
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof OperatorClientError) throw error;
    throw new OperatorClientError(
      nodeErrorCode(error) === "ENOENT" ? "not-running" : "protocol",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new OperatorClientError("timeout"));
    }, OPERATOR_CLIENT_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new OperatorClientError(
          nodeErrorCode(error) === "EACCES" ? "protocol" : "not-running",
        ),
      );
    });
  });
}

function receive(socket: Socket): Promise<OperatorResponse> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (category: OperatorClientFailure) => {
      if (settled) return;
      settled = true;
      buffer.fill(0);
      socket.destroy();
      reject(new OperatorClientError(category));
    };
    const timer = setTimeout(
      () => fail("timeout"),
      OPERATOR_CLIENT_RESPONSE_TIMEOUT_MS,
    );
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      const newline = chunk.indexOf(0x0a);
      const segment = newline < 0 ? chunk : chunk.subarray(0, newline);
      if (buffer.byteLength + segment.byteLength > OPERATOR_MAX_FRAME_BYTES) {
        fail("protocol");
        return;
      }
      buffer = Buffer.concat([buffer, segment]);
      if (newline < 0) return;
      const trailing = chunk.subarray(newline + 1);
      if (
        buffer.byteLength === 0 ||
        buffer.byteLength > OPERATOR_MAX_MESSAGE_BYTES ||
        trailing.byteLength > 0
      ) {
        fail("protocol");
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(buffer.toString("utf8"));
      } catch {
        fail("protocol");
        return;
      }
      const parsed = operatorResponseSchema.safeParse(raw);
      if (!parsed.success) {
        fail("protocol");
        return;
      }
      settled = true;
      clearTimeout(timer);
      buffer.fill(0);
      socket.end();
      resolve(parsed.data);
    });
    socket.once("end", () => {
      if (!settled) fail("protocol");
    });
    socket.once("error", () => fail("not-running"));
    socket.once("close", () => clearTimeout(timer));
  });
}

export async function callLocalOperator(command: OperatorCommand): Promise<OperatorResponse> {
  if (process.platform !== "win32") throw new OperatorClientError("not-running");
  const descriptor = await loadDescriptor();
  const socket = await connect(descriptor.endpoint);
  try {
    const request = {
      version: OPERATOR_PROTOCOL_VERSION,
      token: descriptor.token,
      ...command,
    };
    socket.write(encodeOperatorFrame(request));
    return await receive(socket);
  } finally {
    socket.destroy();
  }
}
