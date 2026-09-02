import { Buffer } from "node:buffer";
import {
  INVALID_REQUEST,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  MCP_JSON_RPC_RESERVE_BYTES,
  STDIO_MAX_BUFFER_BYTES,
} from "./server.js";

export const MCP_MAX_JSON_RPC_ID_BYTES = 8 * 1_024;
export const MCP_JSON_RPC_WRAPPER_BYTES =
  MCP_JSON_RPC_RESERVE_BYTES - MCP_MAX_JSON_RPC_ID_BYTES;

const fixedIdError = Object.freeze({
  jsonrpc: "2.0" as const,
  id: null,
  error: Object.freeze({
    code: INVALID_REQUEST,
    message: "The JSON-RPC request ID exceeds the local wire budget.",
  }),
}) as unknown as JSONRPCMessage;

const fixedOutputError = Object.freeze({
  jsonrpc: "2.0" as const,
  id: null,
  error: Object.freeze({
    code: INVALID_REQUEST,
    message: "The JSON-RPC response exceeds the local wire budget.",
  }),
}) as unknown as JSONRPCMessage;

function validRequestId(id: string | number): boolean {
  if (typeof id === "number") return Number.isSafeInteger(id);
  try {
    return Buffer.byteLength(JSON.stringify(id), "utf8") <= MCP_MAX_JSON_RPC_ID_BYTES;
  } catch {
    return false;
  }
}

function messageBytes(message: JSONRPCMessage): number {
  return Buffer.byteLength(serializeMessage(message), "utf8");
}

export class BoundedStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  constructor(readonly inner: StdioServerTransport) {}

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => {
      if (isJSONRPCRequest(message) && !validRequestId(message.id)) {
        void this.inner.send(fixedIdError).catch((error: unknown) => {
          this.onerror?.(
            error instanceof Error ? error : new Error("Bounded stdio write failed."),
          );
        });
        return;
      }
      this.onmessage?.(message);
    };
    await this.inner.start();
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (messageBytes(message) <= STDIO_MAX_BUFFER_BYTES) {
      await this.inner.send(message);
      return;
    }
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      await this.inner.send(fixedOutputError);
      return;
    }
    this.onerror?.(new Error("Bounded stdio notification exceeded its wire budget."));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
