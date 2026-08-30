import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { AdapterRegistry } from "../core/adapter-registry.js";
import { GameBridge } from "../core/bridge.js";
import { ProcessMockAdapter } from "../adapters/mock/process-mock-adapter.js";
import {
  STDIO_MAX_BUFFER_BYTES,
  createGameBridgeMcpServer,
} from "./server.js";

const registry = new AdapterRegistry();
const adapter = new ProcessMockAdapter();
registry.register(adapter);
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
async function close(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  try {
    await handle.close();
  } catch {
    process.stderr.write("Local MCP stdio shutdown error.\n");
  }
  await adapter.close();
}

process.once("SIGINT", () => {
  void close();
});
process.stdin.once("end", () => {
  void close();
});
