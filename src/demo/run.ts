import {
  AdapterRegistry,
  GameBridge,
  MemoryAuditSink,
  MockGameAdapter,
  SessionManager,
  type RequestEnvelope,
} from "../index.js";

const fixedNow = Date.parse("2026-08-29T00:00:00.000Z");
const registry = new AdapterRegistry();
registry.register(new MockGameAdapter());
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

function request(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  mode: "dry-run" | "commit" = "commit",
  sessionId?: string,
): RequestEnvelope {
  return {
    protocolVersion: "1.0",
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    action,
    params,
    mode,
  };
}

async function main(): Promise<void> {
  const opened = await bridge.handle(
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
    { adapterId: "mock-world", gameAction: "move", input: { dx: 1, dy: 0, dz: 0 } },
    "dry-run",
    sessionId,
  );
  const commit = request(
    "demo-commit",
    "game.act",
    { adapterId: "mock-world", gameAction: "move", input: { dx: 1, dy: 0, dz: 0 } },
    "commit",
    sessionId,
  );

  const output = {
    opened,
    preview: await bridge.handle(preview),
    committed: await bridge.handle(commit),
    duplicateCommit: await bridge.handle(commit),
    stopped: await bridge.handle(request("demo-stop", "safety.stop", {}, "commit", sessionId)),
    blockedWrite: await bridge.handle(
      request(
        "demo-blocked",
        "game.act",
        { adapterId: "mock-world", gameAction: "move", input: { dx: 0, dy: 0, dz: 1 } },
        "commit",
        sessionId,
      ),
    ),
    observationWhileStopped: await bridge.handle(
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

await main();
