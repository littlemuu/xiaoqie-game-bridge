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
        : await adapter.execute(message.action, message.input, message.mode, {
            ...(message.expectedRevision === undefined
              ? {}
              : { expectedRevision: message.expectedRevision }),
          });
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
  let offset = 0;
  while (offset < chunk.byteLength) {
    const newline = chunk.indexOf(0x0a, offset);
    const end = newline < 0 ? chunk.byteLength : newline;
    const segment = chunk.subarray(offset, end);
    if (input.byteLength + segment.byteLength > ADAPTER_IPC_MAX_FRAME_BYTES) {
      failClosed();
    }
    input = Buffer.concat([input, segment]);
    if (newline < 0) return;
    if (input.byteLength === 0 || input.byteLength > ADAPTER_IPC_MAX_MESSAGE_BYTES) {
      failClosed();
    }
    const frame = input;
    input = Buffer.alloc(0);
    offset = newline + 1;
    void handleFrame(frame).catch(failClosed);
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
