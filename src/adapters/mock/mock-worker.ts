import { AdapterExecutionError } from "../../core/adapter.js";
import { MockGameAdapter } from "./mock-adapter.js";
import {
  ADAPTER_IPC_MAX_FRAME_BYTES,
  ADAPTER_IPC_MAX_MESSAGE_BYTES,
  ADAPTER_IPC_VERSION,
  MOCK_ADAPTER_IDENTITY,
  adapterParentMessageSchema,
  encodeAdapterFrame,
} from "./adapter-ipc.js";

const adapter = new MockGameAdapter();
let input = Buffer.alloc(0);
let closing = false;

function write(message: unknown, callback?: () => void): void {
  process.stdout.write(encodeAdapterFrame(message), callback);
}

function failClosed(): never {
  process.stdin.pause();
  process.exit(1);
}

async function handleFrame(frame: Buffer): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(frame.toString("utf8"));
  } catch {
    failClosed();
  }
  const parsed = adapterParentMessageSchema.safeParse(raw);
  if (!parsed.success || closing) {
    failClosed();
  }
  const message = parsed.data;
  if (message.type === "shutdown") {
    closing = true;
    process.stdin.pause();
    write({ version: ADAPTER_IPC_VERSION, type: "shutdown-complete" }, () => {
      process.exit(0);
    });
    return;
  }

  try {
    const result =
      message.operation === "observe"
        ? await adapter.observe()
        : await adapter.execute(message.action, message.input, message.mode);
    write({
      version: ADAPTER_IPC_VERSION,
      type: "result",
      callId: message.callId,
      ok: true,
      result,
    });
  } catch (error) {
    write({
      version: ADAPTER_IPC_VERSION,
      type: "result",
      callId: message.callId,
      ok: false,
      error: {
        code: error instanceof AdapterExecutionError ? error.code : "ADAPTER_FAILURE",
      },
    });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  if (input.byteLength + chunk.byteLength > ADAPTER_IPC_MAX_FRAME_BYTES) {
    failClosed();
  }
  input = Buffer.concat([input, chunk]);
  let newline = input.indexOf(0x0a);
  while (newline >= 0) {
    const frame = input.subarray(0, newline);
    input = input.subarray(newline + 1);
    if (
      frame.byteLength === 0 ||
      frame.byteLength > ADAPTER_IPC_MAX_FRAME_BYTES ||
      frame.byteLength > ADAPTER_IPC_MAX_MESSAGE_BYTES
    ) {
      failClosed();
    }
    void handleFrame(frame).catch(failClosed);
    newline = input.indexOf(0x0a);
  }
});
process.stdin.once("end", () => {
  if (!closing) {
    failClosed();
  }
});
process.stdin.once("error", failClosed);

write({
  version: ADAPTER_IPC_VERSION,
  type: "ready",
  adapter: MOCK_ADAPTER_IDENTITY,
});
