import { createConnection, type Socket } from "node:net";

const MAX_PACKET = 4_096;
const MAX_RESPONSE = 16_384;

/** A bounded, one-command-per-connection RCON client. No reconnect/retry. */
export class LocalRcon {
  readonly #sockets = new Set<Socket>();
  #closed = false;
  constructor(readonly port: number, private readonly password: string, readonly timeoutMs = 3_000) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
        !/^[a-f0-9]{64}$/.test(password) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Invalid local RCON configuration.");
    }
  }

  command(command: string, beforeSend?: () => boolean): Promise<string> {
    if (this.#closed || this.#sockets.size >= 4 || Buffer.byteLength(command) > 1_024 || /[\r\n\0]/.test(command)) {
      return Promise.reject(new Error("RCON is unavailable."));
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: this.port });
      this.#sockets.add(socket);
      let buffer: Buffer = Buffer.alloc(0);
      let authenticated = false;
      let settled = false;
      let response = "";
      const timer = setTimeout(() => finish(new Error("RCON deadline exceeded.")), this.timeoutMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#sockets.delete(socket);
        socket.destroy();
        error ? reject(error) : resolve(response);
      };
      const send = (id: number, type: number, body: string) => {
        const data = Buffer.from(body, "utf8");
        const packet = Buffer.alloc(data.length + 14);
        packet.writeInt32LE(data.length + 10, 0);
        packet.writeInt32LE(id, 4);
        packet.writeInt32LE(type, 8);
        data.copy(packet, 12);
        socket.write(packet);
      };
      socket.once("connect", () => send(1, 3, this.password));
      socket.on("error", () => finish(new Error("RCON connection failed.")));
      socket.once("close", () => finish(new Error("RCON disconnected.")));
      socket.on("data", (chunk: Buffer) => {
        if (buffer.length + chunk.length > MAX_RESPONSE) return finish(new Error("RCON frame limit."));
        buffer = Buffer.concat([buffer, chunk]);
        while (!settled && buffer.length >= 4) {
          const length = buffer.readInt32LE(0);
          if (length < 10 || length > MAX_PACKET) return finish(new Error("RCON frame invalid."));
          if (buffer.length < length + 4) return;
          const packet = buffer.subarray(0, length + 4);
          buffer = buffer.subarray(length + 4);
          const id = packet.readInt32LE(4);
          const type = packet.readInt32LE(8);
          if (packet[length + 2] !== 0 || packet[length + 3] !== 0 || id === -1) {
            return finish(new Error("RCON authentication or frame invalid."));
          }
          const body = packet.subarray(12, length + 2).toString("utf8");
          if (!authenticated) {
            // Some servers precede AUTH_RESPONSE with an empty RESPONSE_VALUE.
            if (id === 1 && type === 0 && body === "") continue;
            if (id !== 1 || type !== 2) return finish(new Error("RCON authentication invalid."));
            authenticated = true;
            if (beforeSend !== undefined && !beforeSend()) return finish(new Error("RCON dispatch disabled."));
            send(2, 2, command);
            // A second harmless command is an ordered end marker, including multi-packet replies.
            send(3, 2, "data get storage xqb:state state");
          } else if (id === 2 && type === 0) {
            response += body;
            if (Buffer.byteLength(response) > MAX_RESPONSE) return finish(new Error("RCON response limit."));
          } else if (id === 3 && type === 0) {
            finish();
          } else {
            return finish(new Error("RCON response identity invalid."));
          }
        }
      });
    });
  }

  close(): void {
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
  }
}
