import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMinecraftRuntime } from "../runtime/minecraft-runtime.js";
import { BoundedStdioServerTransport } from "./bounded-stdio-transport.js";
import { createGameBridgeMcpServer, STDIO_MAX_BUFFER_BYTES } from "./server.js";
import { startLocalOperatorServer } from "../operator/server.js";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--allow-writes")) throw new Error("Invalid startup options.");
  const runtime = await createMinecraftRuntime();
  let operator: Awaited<ReturnType<typeof startLocalOperatorServer>> | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    if (process.platform === "win32") {
      operator = await startLocalOperatorServer(runtime.control, { onFatal: () => { void stop?.(); } });
    }
    if (args[0] === "--allow-writes") {
      if (runtime.journal.pending()) throw new Error("Reconciliation required.");
      const resumed = await runtime.control.resumeSafety(runtime.safetyLatch.status().stopGeneration);
      if (!resumed.resumed) throw new Error("Local enable failed.");
    }
    const transport = new BoundedStdioServerTransport(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: STDIO_MAX_BUFFER_BYTES }));
    const handle = serveStdio(() => createGameBridgeMcpServer({ bridge: runtime.bridge }), { transport, onerror: () => { void stop?.(); } });
    let closing: Promise<void> | undefined;
    stop = () => closing ??= (async () => {
      runtime.safetyLatch.stop();
      await operator?.close().catch(() => undefined);
      await runtime.close();
      await handle.close().catch(() => undefined);
      process.stdin.pause();
    })();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void stop?.(); });
    process.stdin.once("end", () => { void stop?.(); });
    process.stdin.once("close", () => { void stop?.(); });
    process.once("exit", () => operator?.cleanupRuntimeObjectsForProcessExit());
  } catch {
    await operator?.close().catch(() => undefined);
    await runtime.close();
    throw new Error("Minecraft MCP startup failed.");
  }
}

await run().catch(() => {
  process.stderr.write("Minecraft MCP startup failed: check the local playtest server, journal and startup options.\n");
  process.exitCode = 1;
  process.stdin.pause();
});
