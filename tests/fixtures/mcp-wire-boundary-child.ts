import { Buffer } from "node:buffer";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  ADAPTER_MAX_RESULT_BYTES,
  ADAPTER_REGISTRY_MAX_ADAPTERS,
  AdapterRegistry,
  GameBridge,
  type CapabilityGrantProvider,
  type GameAdapter,
  type RequestEnvelope,
  successResponse,
} from "../../src/index.js";
import {
  STDIO_MAX_BUFFER_BYTES,
  createGameBridgeMcpServer,
  type BridgeRequestHandler,
} from "../../src/mcp/server.js";
import { BoundedStdioServerTransport } from "../../src/mcp/bounded-stdio-transport.js";

const maximumResultOverhead = Buffer.byteLength(
  JSON.stringify({ payload: "" }),
  "utf8",
);
const maximumResult = Object.freeze({
  payload: "x".repeat(ADAPTER_MAX_RESULT_BYTES - maximumResultOverhead),
});

function adapter(index: number, displayNameLength: number): GameAdapter {
  const maximum = index === 0;
  return {
    id: `wire-${index.toString().padStart(2, "0")}`,
    displayName: "a".repeat(displayNameLength),
    observation: {
      description: "o",
      outputSchema: maximum
        ? z.object({ payload: z.string() }).strict()
        : z.boolean(),
      effectKind: "read",
      concurrency: { kind: "parallel" },
      requiredCapabilities: ["game.observe"],
      maxResultBytes: maximum ? ADAPTER_MAX_RESULT_BYTES : 1,
    },
    actions: {},
    observe: async () => (maximum ? maximumResult : true),
  };
}

function capacityRegistry(): AdapterRegistry {
  let accepted: AdapterRegistry | undefined;
  let low = 1;
  let high = 256;
  while (low <= high) {
    const displayNameLength = Math.floor((low + high) / 2);
    const candidate = new AdapterRegistry();
    try {
      for (let index = 0; index < ADAPTER_REGISTRY_MAX_ADAPTERS; index += 1) {
        candidate.register(adapter(index, displayNameLength));
      }
      accepted = candidate;
      low = displayNameLength + 1;
    } catch {
      high = displayNameLength - 1;
    }
  }
  if (accepted === undefined) throw new Error("wire-boundary-registry-unavailable");
  return accepted;
}

function productBoundaryBridge(): GameBridge {
  const grantProvider: CapabilityGrantProvider = {
    grant(request) {
      return {
        allowed: true,
        capabilities: [...request.requestedCapabilities],
        scope: { kind: request.adapter.id, resourceId: "wire-boundary" },
        ttlMs: request.requestedTtlMs ?? 60_000,
        totalActionBudget: 0,
        perActionBudgets: {},
      };
    },
  };
  return new GameBridge({ registry: capacityRegistry(), grantProvider });
}

const oversizedBridge: BridgeRequestHandler = {
  async handle(envelope) {
    return successResponse(envelope as RequestEnvelope, {
      payload: "x".repeat(STDIO_MAX_BUFFER_BYTES * 2),
    });
  },
};

const bridge =
  process.env.XIAOQIE_TEST_MCP_WIRE_SCENARIO === "oversize"
    ? oversizedBridge
    : productBoundaryBridge();
const transport = new BoundedStdioServerTransport(
  new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: STDIO_MAX_BUFFER_BYTES,
  }),
);
const handle = serveStdio(() => createGameBridgeMcpServer({ bridge }), {
  transport,
  onerror: () => process.stderr.write("Wire boundary fixture transport error.\n"),
});
let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await handle.close().catch(() => undefined);
};
process.stdin.once("end", () => void close());
process.stdin.once("close", () => void close());
