import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { AdapterRegistry } from "../core/adapter-registry.js";
import { GameBridge } from "../core/bridge.js";
import { MockGameAdapter } from "../adapters/mock/mock-adapter.js";
import {
  STDIO_MAX_BUFFER_BYTES,
  createGameBridgeMcpServer,
} from "./server.js";

const registry = new AdapterRegistry();
registry.register(new MockGameAdapter());
const bridge = new GameBridge({ registry });
const transport = new StdioServerTransport(process.stdin, process.stdout, {
  maxBufferSize: STDIO_MAX_BUFFER_BYTES,
});
const handle = serveStdio(() => createGameBridgeMcpServer({ bridge }), {
  transport,
  onerror: () => {
    process.stderr.write("Local MCP stdio transport error.\n");
  },
});

let closing = false;
process.once("SIGINT", () => {
  if (closing) {
    return;
  }
  closing = true;
  void handle.close().catch(() => {
    process.stderr.write("Local MCP stdio shutdown error.\n");
  });
});
