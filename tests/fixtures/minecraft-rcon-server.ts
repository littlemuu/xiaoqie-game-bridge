import { createServer, type Socket } from "node:net";

/** Wire fixture only; deliberately not described as a real Minecraft server. */
export async function startMinecraftWireFixture() {
  const sockets = new Set<Socket>();
  const state = { world: 123, revision: 0, last: 0, status: 0, color: 0 };
  const commands: string[] = [];
  let writes = 0;
  let fault: "none" | "drop-after" | "drop-before" | "save" | "malformed" = "none";
  let deferredCommand: string | undefined;
  const snbt = () => `Storage xqb:state has the following contents: {${Object.entries(state).map(([k, v]) => `${k}: ${v}`).join(", ")}}`;
  const execute = (command: string): string => {
    commands.push(command);
    if (command.startsWith("function xqb:")) {
      const world = Number(/world:(\d+)/.exec(command)?.[1]);
      const sequence = Number(/sequence:(\d+)/.exec(command)?.[1]);
      if (world !== state.world || sequence <= state.last) return "Executed function";
      state.last = sequence; state.status = -1;
      if (command.startsWith("function xqb:set_")) {
        const expected = Number(/expected:(\d+)/.exec(command)?.[1]);
        const color = /set_(lime|gold|blue)/.exec(command)?.[1];
        if (expected === state.revision && color) {
          state.color = ["lime", "gold", "blue"].indexOf(color) + 1;
          state.revision += 1; state.status = 1; writes += 1;
        }
      }
      return "Executed function";
    }
    if (command === "save-all flush") return fault === "save" ? "Save failed" : "Saving the gameSaved the game";
    return snbt();
  };
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    let authenticated = false;
    const respond = (id: number, type: number, body: string) => {
      const bytes = Buffer.from(body);
      const frame = Buffer.alloc(bytes.length + 14);
      frame.writeInt32LE(bytes.length + 10); frame.writeInt32LE(id, 4); frame.writeInt32LE(type, 8); bytes.copy(frame, 12);
      // Deliberately fragment frames to exercise the actual socket parser.
      socket.write(frame.subarray(0, 3)); socket.write(frame.subarray(3));
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const size = buffer.readInt32LE(0) + 4;
        const packet = buffer.subarray(0, size); buffer = buffer.subarray(size);
        const id = packet.readInt32LE(4); const type = packet.readInt32LE(8); const command = packet.subarray(12, size - 2).toString();
        if (!authenticated) {
          if (type !== 3 || command !== "a".repeat(64)) { respond(-1, 2, ""); return; }
          authenticated = true; respond(id, 2, ""); continue;
        }
        if (fault === "malformed") { socket.write(Buffer.from([255, 255, 255, 127])); return; }
        if (id === 2 && command.startsWith("function xqb:set_") && (fault === "drop-before" || fault === "drop-after")) {
          if (fault === "drop-after") execute(command); else deferredCommand = command;
          socket.destroy(); return;
        }
        respond(id, 0, execute(command));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture listener failed.");
  return {
    port: address.port, state, commands,
    get writes() { return writes; },
    set fault(value: typeof fault) { fault = value; },
    deliverLate() { if (deferredCommand) { execute(deferredCommand); deferredCommand = undefined; } },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
