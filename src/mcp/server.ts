import { Buffer } from "node:buffer";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { redactSensitive } from "../core/audit.js";
import type { RequestContext } from "../core/bridge.js";
import {
  type BridgeResponse,
  type RequestEnvelope,
  errorResponse,
  requestEnvelopeSchema,
  responseEnvelopeSchema,
} from "../core/protocol.js";

export const GAME_BRIDGE_TOOL_NAME = "game_bridge_request";
export const STDIO_MAX_BUFFER_BYTES = 64 * 1_024;
export const MCP_MAX_ENVELOPE_BYTES = 32 * 1_024;
export const MCP_MAX_CONCURRENT_HANDLERS = 8;

export const STDIO_LOCAL_CONTEXT: Readonly<RequestContext> = Object.freeze({
  transport: "local",
});

export interface BridgeRequestHandler {
  handle(raw: unknown, context: RequestContext): Promise<BridgeResponse>;
}

export interface HandlerPermit {
  release(): void;
}

export class HandlerConcurrencyGate {
  readonly #maximum: number;
  #inFlight = 0;

  constructor(maximum = MCP_MAX_CONCURRENT_HANDLERS) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new RangeError("Handler concurrency must be a positive safe integer.");
    }
    this.#maximum = maximum;
  }

  tryAcquire(): HandlerPermit | undefined {
    if (this.#inFlight >= this.#maximum) {
      return undefined;
    }
    this.#inFlight += 1;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#inFlight -= 1;
      },
    });
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get maximum(): number {
    return this.#maximum;
  }
}

export interface GameBridgeMcpServerOptions {
  bridge: BridgeRequestHandler;
  handlerGate?: HandlerConcurrencyGate;
  maxConcurrentHandlers?: number;
  maxEnvelopeBytes?: number;
}

function requirePositiveByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("MCP envelope byte limit must be a positive safe integer.");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("The MCP response is not JSON serializable.");
  }
  return serialized;
}

function fixedInternalResponse(request: RequestEnvelope): BridgeResponse {
  return errorResponse(
    request,
    "INTERNAL_ERROR",
    "The local MCP boundary could not produce a valid bridge response.",
  );
}

function responseMatchesRequest(
  response: BridgeResponse,
  request: RequestEnvelope,
): boolean {
  return (
    response.requestId === request.requestId &&
    response.action === request.action &&
    response.mode === request.mode &&
    response.sessionId === request.sessionId
  );
}

function toolResult(response: BridgeResponse): CallToolResult {
  const sanitized = redactSensitive(response);
  const parsed = responseEnvelopeSchema.safeParse(sanitized);
  if (!parsed.success) {
    throw new TypeError("The sanitized bridge response is invalid.");
  }
  const validated = sanitized as BridgeResponse;
  const text = canonicalJson(validated);
  return {
    content: [{ type: "text", text }],
    structuredContent: validated,
    ...(!validated.ok ? { isError: true } : {}),
  };
}

function safeToolResult(response: BridgeResponse, request: RequestEnvelope): CallToolResult {
  try {
    return toolResult(response);
  } catch {
    return toolResult(fixedInternalResponse(request));
  }
}

export function createGameBridgeMcpServer(
  options: GameBridgeMcpServerOptions,
): McpServer {
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? MCP_MAX_ENVELOPE_BYTES;
  requirePositiveByteLimit(maxEnvelopeBytes);
  if (
    options.handlerGate !== undefined &&
    options.maxConcurrentHandlers !== undefined
  ) {
    throw new TypeError(
      "Provide either handlerGate or maxConcurrentHandlers, not both.",
    );
  }
  const handlerGate =
    options.handlerGate ??
    new HandlerConcurrencyGate(
      options.maxConcurrentHandlers ?? MCP_MAX_CONCURRENT_HANDLERS,
    );
  const server = new McpServer({
    name: "xiaoqie-game-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    GAME_BRIDGE_TOOL_NAME,
    {
      title: "Local mock game bridge request",
      description:
        "Send one versioned request to the local in-memory mock game bridge. " +
        "The request may perform a commit, but it cannot access an open world or a real game.",
      inputSchema: requestEnvelopeSchema,
      outputSchema: responseEnvelopeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (request) => {
      let envelopeBytes: number;
      try {
        envelopeBytes = Buffer.byteLength(canonicalJson(request), "utf8");
      } catch {
        return safeToolResult(fixedInternalResponse(request), request);
      }
      if (envelopeBytes > maxEnvelopeBytes) {
        return safeToolResult(
          errorResponse(
            request,
            "RESOURCE_CAPACITY",
            "The local MCP request envelope exceeds its byte limit.",
          ),
          request,
        );
      }

      const permit = handlerGate.tryAcquire();
      if (permit === undefined) {
        return safeToolResult(
          errorResponse(
            request,
            "RESOURCE_CAPACITY",
            "The local MCP handler concurrency limit is exhausted.",
          ),
          request,
        );
      }

      try {
        let response = fixedInternalResponse(request);
        try {
          const candidate = await options.bridge.handle(request, STDIO_LOCAL_CONTEXT);
          if (
            responseEnvelopeSchema.safeParse(candidate).success &&
            responseMatchesRequest(candidate, request)
          ) {
            response = candidate;
          }
        } catch {
          // The fixed response remains the only protocol-visible failure.
        }
        return safeToolResult(response, request);
      } finally {
        permit.release();
      }
    },
  );

  return server;
}
