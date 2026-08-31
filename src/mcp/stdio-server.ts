import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { startLocalOperatorServer } from "../operator/server.js";
import { createProductRuntime } from "../runtime/product-runtime.js";
import {
  STDIO_MAX_BUFFER_BYTES,
  createGameBridgeMcpServer,
} from "./server.js";

async function run(): Promise<void> {
  let runtime;
  try {
    runtime = await createProductRuntime();
  } catch {
    process.stderr.write("Local audit ledger startup failed.\n");
    process.exitCode = 1;
    process.stdin.pause();
    return;
  }
  let closing = false;
  let closeRuntime: (() => Promise<void>) | undefined;
  let operator;
  try {
    operator = await startLocalOperatorServer(runtime.control, {
      onFatal: () => {
        void closeRuntime?.();
      },
    });
  } catch {
    process.stderr.write("Local operator control startup failed.\n");
    await runtime.close().catch(() => undefined);
    process.exitCode = 1;
    process.stdin.pause();
    return;
  }
  process.once("exit", () => operator.cleanupRuntimeObjectsForProcessExit());

  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: STDIO_MAX_BUFFER_BYTES,
  });
  const handle = serveStdio(() => createGameBridgeMcpServer({ bridge: runtime.bridge }), {
    transport,
    onerror: () => {
      process.stderr.write("Local MCP stdio transport error.\n");
      void closeRuntime?.();
    },
  });

  closeRuntime = async () => {
    if (closing) return;
    closing = true;
    const handleClosing = handle.close().catch(() => {
      process.stderr.write("Local MCP stdio shutdown error.\n");
    });
    await operator.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    await Promise.race([
      handleClosing,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
      }),
    ]);
  };

  process.once("SIGINT", () => {
    void closeRuntime?.();
  });
  process.once("SIGTERM", () => {
    void closeRuntime?.();
  });
  process.stdin.once("end", () => {
    void closeRuntime?.();
  });
  process.stdin.once("close", () => {
    void closeRuntime?.();
  });
}

await run();
