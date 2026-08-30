import {
  ADAPTER_IPC_MAX_FRAME_BYTES,
  ADAPTER_IPC_MAX_MESSAGE_BYTES,
  ADAPTER_IPC_VERSION,
  MOCK_ADAPTER_IDENTITY,
} from "../../src/adapters/mock/adapter-ipc.js";

const mode = process.env.XIAOQIE_TEST_MODE ?? "hang";
const observation = {
  player: { x: 0, y: 1, z: 0 },
  nearbyBlocks: [],
};

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (mode === "no-handshake") {
  setInterval(() => undefined, 1_000).unref();
} else {
  write({
    version: ADAPTER_IPC_VERSION,
    type: "ready",
    adapter:
      mode === "bad-handshake"
        ? { ...MOCK_ADAPTER_IDENTITY, id: "forged-adapter" }
        : MOCK_ADAPTER_IDENTITY,
  });
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  const newline = input.indexOf("\n");
  if (newline < 0) return;
  const frame = input.slice(0, newline);
  input = input.slice(newline + 1);
  let callId = "call-1";
  try {
    const parsed = JSON.parse(frame) as { callId?: unknown };
    if (typeof parsed.callId === "string") callId = parsed.callId;
  } catch {}

  switch (mode) {
    case "malformed":
      process.stdout.write("Bearer-worker-secret C:\\private\\worker stack\n");
      break;
    case "unknown-field":
      write({ version: ADAPTER_IPC_VERSION, type: "result", callId, ok: true, result: {}, extra: true });
      break;
    case "unknown-type":
      write({ version: ADAPTER_IPC_VERSION, type: "surprise", callId });
      break;
    case "oversized":
      process.stdout.write(`${"x".repeat(ADAPTER_IPC_MAX_MESSAGE_BYTES + 1)}\n`);
      break;
    case "wrong-id":
      write({ version: ADAPTER_IPC_VERSION, type: "result", callId: "call-999", ok: true, result: observation });
      break;
    case "duplicate-id": {
      const result = { version: ADAPTER_IPC_VERSION, type: "result", callId, ok: true, result: observation };
      write(result);
      write(result);
      break;
    }
    case "crash":
      process.exit(7);
      break;
    case "eof":
      process.stdout.end(() => process.exit(0));
      break;
    case "env-check":
      write({
        version: ADAPTER_IPC_VERSION,
        type: "result",
        callId,
        ok: true,
        result: process.env.ADAPTER_PASSWORD_SENTINEL === undefined
          ? observation
          : { player: { x: 99, y: 1, z: 0 }, nearbyBlocks: [] },
      });
      break;
    case "wrong-result":
      write({
        version: ADAPTER_IPC_VERSION,
        type: "result",
        callId,
        ok: true,
        result: {
          applied: true,
          change: {
            type: "move",
            from: { x: 0, y: 1, z: 0 },
            to: { x: 1, y: 1, z: 0 },
          },
        },
      });
      break;
    case "credential-result":
      write({
        version: ADAPTER_IPC_VERSION,
        type: "result",
        callId,
        ok: true,
        result: { authorization: "Bearer-worker-result-secret" },
      });
      break;
    case "hang":
    default:
      break;
  }
});
