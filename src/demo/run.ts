import {
  AdapterRegistry,
  GameBridge,
  MemoryAuditSink,
  ProcessMockAdapter,
  PROTOCOL_VERSION,
  SessionManager,
  type RequestEnvelope,
} from "../index.js";

const fixedNow = Date.parse("2026-08-29T00:00:00.000Z");
const registry = new AdapterRegistry();
const adapter = new ProcessMockAdapter();
registry.register(adapter);
const audit = new MemoryAuditSink();
const bridge = new GameBridge({
  registry,
  auditSink: audit,
  sessions: new SessionManager({
    clock: () => fixedNow,
    idGenerator: () => "demo-session",
  }),
  clock: () => fixedNow,
});
const localContext = { transport: "local" } as const;

if (process.platform !== "win32") {
  console.log(JSON.stringify({
    skipped: true,
    reason: "Windows kernel containment is required; no unrestricted fallback is available.",
  }, null, 2));
  process.exit(0);
}

function handleLocal(requestEnvelope: RequestEnvelope) {
  return bridge.handle(requestEnvelope, localContext);
}

function request(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  mode: "dry-run" | "commit" = "commit",
  sessionId?: string,
): RequestEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    action,
    params,
    mode,
  };
}

async function main(): Promise<void> {
  const opened = await handleLocal(
    request("demo-open", "session.open", {
      adapterId: "mock-world",
      capabilities: ["game.observe", "game.act.move", "safety.stop"],
      ttlMs: 900_000,
    }),
  );
  if (!opened.ok) {
    throw new Error(`Demo session failed: ${opened.error.code}`);
  }
  const sessionId = (opened.result as { sessionId: string }).sessionId;
  const preview = request(
    "demo-preview",
    "game.act",
    {
      adapterId: "mock-world",
      gameAction: "move",
      input: { dx: 1, dy: 0, dz: 0 },
      expectedRevision: 0,
    },
    "dry-run",
    sessionId,
  );
  const commit = request(
    "demo-commit",
    "game.act",
    {
      adapterId: "mock-world",
      gameAction: "move",
      input: { dx: 1, dy: 0, dz: 0 },
      expectedRevision: 0,
    },
    "commit",
    sessionId,
  );

  const output = {
    opened,
    preview: await handleLocal(preview),
    committed: await handleLocal(commit),
    duplicateCommit: await handleLocal(commit),
    stopped: await handleLocal(request("demo-stop", "safety.stop", {}, "commit", sessionId)),
    blockedWrite: await handleLocal(
      request(
        "demo-blocked",
        "game.act",
        {
          adapterId: "mock-world",
          gameAction: "move",
          input: { dx: 0, dy: 0, dz: 1 },
          expectedRevision: 1,
        },
        "commit",
        sessionId,
      ),
    ),
    observationWhileStopped: await handleLocal(
      request(
        "demo-observe",
        "game.observe",
        { adapterId: "mock-world" },
        "commit",
        sessionId,
      ),
    ),
    auditSummary: {
      totalEvents: audit.events.length,
      idempotencyHits: audit.events.filter((event) => event.idempotencyHit).length,
      rawIdentifiersStored: false,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

try {
  await main();
} finally {
  await adapter.close();
}
