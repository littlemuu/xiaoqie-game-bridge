import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AdapterActionDefinition,
  type AdapterObservationDefinition,
  AdapterRegistry,
  type BridgeMode,
  type BridgeResponse,
  type CapabilityGrantProvider,
  GameBridge,
  type GameAdapter,
  MockGameAdapter,
  PACKAGE_VERSION,
  SessionManager,
  errorResponse,
  responseEnvelopeSchema,
  successResponse,
  type RequestContext,
  type RequestEnvelope,
} from "../src/index.js";
import {
  GAME_BRIDGE_TOOL_NAME,
  HandlerConcurrencyGate,
  STDIO_LOCAL_CONTEXT,
  STDIO_MAX_BUFFER_BYTES,
  createGameBridgeMcpServer,
  type BridgeRequestHandler,
} from "../src/mcp/server.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function request(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  options: { sessionId?: string; mode?: "dry-run" | "commit" } = {},
): RequestEnvelope {
  return {
    protocolVersion: "1.0",
    requestId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    action,
    params,
    mode: options.mode ?? "commit",
  };
}

function toolArguments(envelope: RequestEnvelope): Record<string, unknown> {
  return envelope as unknown as Record<string, unknown>;
}

function parseBridgeResponse(result: {
  structuredContent?: unknown;
}): BridgeResponse {
  const parsed = responseEnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success).toBe(true);
  return result.structuredContent as BridgeResponse;
}

function textContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const text = result.content.find((item) => item.type === "text")?.text;
  expect(text).toBeTypeOf("string");
  return text!;
}

function expectBridgeError(response: BridgeResponse, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe(code);
  }
}

interface Connection {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

const openConnections: Connection[] = [];
const temporaryProfiles = new Set<string>();

async function isolatedChildEnvironment(): Promise<Record<string, string>> {
  const profile = await mkdtemp(join(tmpdir(), "xiaoqie-product-profile-"));
  temporaryProfiles.add(profile);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, HOME: profile, USERPROFILE: profile };
}

async function connectInMemory(server: McpServer): Promise<Connection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "game-bridge-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let closed = false;
  const connection: Connection = {
    client,
    server,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await client.close();
      await server.close();
    },
  };
  openConnections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.allSettled(openConnections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    [...temporaryProfiles].map(async (profile) => {
      await rm(profile, { recursive: true, force: true });
      temporaryProfiles.delete(profile);
    }),
  );
});

function createMockBridge(options: { sessions?: SessionManager } = {}): GameBridge {
  const registry = new AdapterRegistry();
  registry.register(new MockGameAdapter());
  return new GameBridge({
    registry,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  });
}

class DomainFieldAdapter implements GameAdapter {
  readonly id = "domain-fields";
  readonly displayName = "Domain field contract adapter";
  readonly observation: AdapterObservationDefinition = {
    description: "Return one harmless domain token value.",
    outputSchema: z.object({ token: z.number() }).strict(),
    effectKind: "read",
    concurrency: { kind: "parallel" },
    requiredCapabilities: ["game.observe"],
    maxResultBytes: 128,
  };
  readonly actions: Readonly<Record<string, AdapterActionDefinition>> = {
    inspect: {
      description: "Validate ordinary domain field names.",
      inputSchema: z
        .object({ path: z.string(), token: z.number(), password: z.string() })
        .strict(),
      outputSchema: z.object({ token: z.number() }).strict(),
      effectKind: "preview",
      dryRunSemantics: "exact",
      requiredCapabilities: ["game.act.inspect"],
      maxResultBytes: 128,
      writeConcurrency: { kind: "none" },
      adapterErrorCodes: [],
      requiresExpectedRevision: false,
      reconciliation: "unsupported",
    },
  };

  async observe(): Promise<unknown> {
    return { token: 7 };
  }

  async execute(
    _action: string,
    _input: unknown,
    _mode: BridgeMode,
  ): Promise<unknown> {
    return { token: 7 };
  }
}

function createDomainFieldBridge(): GameBridge {
  const adapter = new DomainFieldAdapter();
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const grantProvider: CapabilityGrantProvider = {
    grant(grantRequest) {
      return {
        allowed: true,
        capabilities: [...grantRequest.requestedCapabilities],
        scope: { kind: adapter.id, resourceId: "domain-world" },
        ttlMs: grantRequest.requestedTtlMs ?? 60_000,
        totalActionBudget: 0,
        perActionBudgets: {},
      };
    },
  };
  return new GameBridge({
    registry,
    sessions: new SessionManager({ idGenerator: () => "domain-session" }),
    grantProvider,
  });
}

async function callBridge(client: Client, envelope: RequestEnvelope) {
  return client.callTool({
    name: GAME_BRIDGE_TOOL_NAME,
    arguments: toolArguments(envelope),
  });
}

describe("local MCP contract", () => {
  it("advertises only the conservative game bridge tool", async () => {
    const { client } = await connectInMemory(
      createGameBridgeMcpServer({ bridge: createMockBridge() }),
    );

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: GAME_BRIDGE_TOOL_NAME,
      inputSchema: { additionalProperties: false },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    expect(client.getServerCapabilities()).not.toHaveProperty("resources");
    expect(client.getServerCapabilities()).not.toHaveProperty("prompts");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("safety.resume");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("safety.status");
  });

  it("preserves validated domain field names and number outputs across the real MCP boundary", async () => {
    const { client } = await connectInMemory(
      createGameBridgeMcpServer({ bridge: createDomainFieldBridge() }),
    );

    const describeResult = await callBridge(
      client,
      request("domain-describe", "bridge.describe", {}),
    );
    const described = parseBridgeResponse(describeResult);
    expect(described.ok).toBe(true);
    expect(JSON.parse(textContent(describeResult))).toEqual(described);
    const inputSchema = (
      described as {
        result: {
          adapters: Array<{
            actions: { inspect: { inputSchema: { properties: Record<string, unknown> } } };
          }>;
        };
      }
    ).result.adapters[0]!.actions.inspect.inputSchema;
    expect(inputSchema.properties).toMatchObject({
      path: { type: "string" },
      token: { type: "number" },
      password: { type: "string" },
    });

    const opened = parseBridgeResponse(
      await callBridge(
        client,
        request("domain-open", "session.open", {
          adapterId: "domain-fields",
          capabilities: ["game.act.inspect"],
        }),
      ),
    );
    expect(opened.ok).toBe(true);
    const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
    const actionResult = await callBridge(
      client,
      request(
        "domain-result",
        "game.act",
        {
          adapterId: "domain-fields",
          gameAction: "inspect",
          input: { path: "inventory.slot", token: 42, password: "puzzle-answer" },
        },
        { sessionId, mode: "dry-run" },
      ),
    );
    const actionResponse = parseBridgeResponse(actionResult);
    expect(actionResponse).toMatchObject({ ok: true, result: { token: 7 } });
    expect(typeof (actionResponse as { result: { token: unknown } }).result.token).toBe(
      "number",
    );
    expect(JSON.parse(textContent(actionResult))).toEqual(actionResponse);
  });

  it("injects frozen local context and rejects caller-supplied identity fields", async () => {
    const sessions = new SessionManager({ idGenerator: () => "mcp-session" });
    const { client } = await connectInMemory(
      createGameBridgeMcpServer({ bridge: createMockBridge({ sessions }) }),
    );
    expect(client.getServerVersion()).toEqual({
      name: "xiaoqie-game-bridge",
      version: PACKAGE_VERSION,
    });

    const opened = parseBridgeResponse(
      await callBridge(
        client,
        request("open-local", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe"],
        }),
      ),
    );
    expect(opened.ok).toBe(true);
    expect(sessions.size).toBe(1);

    const injectedSecret = "Bearer-schema-secret-123";
    const invalidArguments = {
      ...toolArguments(
        request("forged-context", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe"],
        }),
      ),
      context: { transport: "local" },
      principal: { subject: injectedSecret, method: "forged" },
    };
    let invalidOutcome: unknown;
    try {
      invalidOutcome = await client.callTool({
        name: GAME_BRIDGE_TOOL_NAME,
        arguments: invalidArguments,
      });
    } catch (error) {
      invalidOutcome = error instanceof Error ? error.message : "fixed client error";
    }
    expect(invalidOutcome).toMatchObject({ isError: true });
    expect(sessions.size).toBe(1);
    expect(JSON.stringify(invalidOutcome)).not.toContain(injectedSecret);

    expect(Object.isFrozen(STDIO_LOCAL_CONTEXT)).toBe(true);
    expect(STDIO_LOCAL_CONTEXT).toEqual({ transport: "local" });
    expect("principal" in STDIO_LOCAL_CONTEXT).toBe(false);
  });

  it("preserves dry-run, idempotency, request reuse, and safety semantics", async () => {
    const sessions = new SessionManager({ idGenerator: () => "flow-session" });
    const { client } = await connectInMemory(
      createGameBridgeMcpServer({ bridge: createMockBridge({ sessions }) }),
    );

    const opened = parseBridgeResponse(
      await callBridge(
        client,
        request("flow-open", "session.open", {
          adapterId: "mock-world",
          capabilities: ["game.observe", "game.act.move", "safety.stop"],
        }),
      ),
    );
    expect(opened.ok).toBe(true);
    const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;

    const observe = (requestId: string) =>
      request(
        requestId,
        "game.observe",
        { adapterId: "mock-world" },
        { sessionId },
      );
    const move = (
      requestId: string,
      dx: number,
      mode: "dry-run" | "commit" = "commit",
    ) =>
      request(
        requestId,
        "game.act",
        {
          adapterId: "mock-world",
          gameAction: "move",
          input: { dx, dy: 0, dz: 0 },
          expectedRevision: 0,
        },
        { sessionId, mode },
      );

    const before = parseBridgeResponse(await callBridge(client, observe("observe-before")));
    const preview = parseBridgeResponse(await callBridge(client, move("move-preview", 1, "dry-run")));
    const afterPreview = parseBridgeResponse(
      await callBridge(client, observe("observe-after-preview")),
    );
    expect(preview.ok && preview.result).toMatchObject({ applied: false });
    expect(before.ok).toBe(true);
    expect(afterPreview.ok).toBe(true);
    if (before.ok && afterPreview.ok) {
      expect(before.result).toEqual(afterPreview.result);
    }

    const commitRequest = move("move-commit", 1);
    const committed = parseBridgeResponse(await callBridge(client, commitRequest));
    const duplicate = parseBridgeResponse(await callBridge(client, commitRequest));
    expect(duplicate).toEqual(committed);
    const afterCommit = parseBridgeResponse(
      await callBridge(client, observe("observe-after-commit")),
    );
    expect(afterCommit.ok && afterCommit.result).toMatchObject({
      player: { x: 1, y: 1, z: 0 },
    });

    const reused = await callBridge(client, move("move-commit", -1));
    expectBridgeError(parseBridgeResponse(reused), "REQUEST_ID_REUSED");
    expect(reused.isError).toBe(true);
    expect(
      (
        parseBridgeResponse(
          await callBridge(
            client,
            request("stop", "safety.stop", {}, { sessionId }),
          ),
        )
      ).ok,
    ).toBe(true);
    expectBridgeError(
      parseBridgeResponse(await callBridge(client, move("move-after-stop", -1))),
      "SAFETY_STOPPED",
    );
    expectBridgeError(
      parseBridgeResponse(
        await callBridge(
          client,
          request("resume", "safety.resume", {}, { sessionId }),
        ),
      ),
      "UNKNOWN_ACTION",
    );
  });

  it("rejects logical oversize before bridge entry without leaking input", async () => {
    const injectedSecret = "password-shaped-review-secret-123";
    let bridgeCalls = 0;
    const bridge: BridgeRequestHandler = {
      async handle(envelope) {
        bridgeCalls += 1;
        return successResponse(envelope as RequestEnvelope, { entered: true });
      },
    };
    const { client } = await connectInMemory(
      createGameBridgeMcpServer({ bridge, maxEnvelopeBytes: 256 }),
    );

    const result = await callBridge(
      client,
      request("logical-oversize", "bridge.describe", {
        payload: injectedSecret.repeat(20),
      }),
    );
    expectBridgeError(parseBridgeResponse(result), "RESOURCE_CAPACITY");
    expect(result.isError).toBe(true);
    expect(bridgeCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(injectedSecret);
  });

  it("bounds concurrent handlers and releases permits after all outcomes", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    let calls = 0;
    const bridge: BridgeRequestHandler = {
      async handle(envelope, context) {
        const parsedEnvelope = envelope as RequestEnvelope;
        calls += 1;
        expect(context).toBe(STDIO_LOCAL_CONTEXT);
        if (calls === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        if (parsedEnvelope.action === "throw") {
          throw new Error("Bearer-unknown-bridge-failure");
        }
        if (parsedEnvelope.action === "invalid-output") {
          return undefined as unknown as BridgeResponse;
        }
        return successResponse(parsedEnvelope, { entered: calls });
      },
    };
    const gate = new HandlerConcurrencyGate(1);
    const { client } = await connectInMemory(
      createGameBridgeMcpServer({ bridge, handlerGate: gate }),
    );

    const firstRequest = request("concurrency-1", "bridge.describe", {});
    const first = callBridge(client, firstRequest);
    await firstEntered.promise;
    expect(gate.inFlight).toBe(1);
    expect(gate.maximum).toBe(1);

    const rejected = parseBridgeResponse(
      await callBridge(client, request("concurrency-2", "bridge.describe", {})),
    );
    expectBridgeError(rejected, "RESOURCE_CAPACITY");
    expect(calls).toBe(1);

    releaseFirst.resolve();
    expect((await first).isError).not.toBe(true);
    expect(gate.inFlight).toBe(0);
    expect(
      (await callBridge(client, request("concurrency-3", "bridge.describe", {}))).isError,
    ).not.toBe(true);
    expect(calls).toBe(2);
    expect(gate.inFlight).toBe(0);

    const thrown = await callBridge(client, request("throwing", "throw", {}));
    expectBridgeError(parseBridgeResponse(thrown), "INTERNAL_ERROR");
    expect(JSON.stringify(thrown)).not.toContain("Bearer-unknown-bridge-failure");
    expect(gate.inFlight).toBe(0);

    const invalid = await callBridge(
      client,
      request("invalid-result", "invalid-output", {}),
    );
    expectBridgeError(parseBridgeResponse(invalid), "INTERNAL_ERROR");
    expect(gate.inFlight).toBe(0);
  });

  it("releases a pending handler permit after the client disconnects", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const gate = new HandlerConcurrencyGate(1);
    const bridge: BridgeRequestHandler = {
      async handle(envelope) {
        entered.resolve();
        await release.promise;
        return successResponse(envelope as RequestEnvelope, { finished: true });
      },
    };
    const connection = await connectInMemory(
      createGameBridgeMcpServer({ bridge, handlerGate: gate }),
    );

    const pending = callBridge(
      connection.client,
      request("disconnect", "bridge.describe", {}),
    );
    await entered.promise;
    expect(gate.inFlight).toBe(1);
    const closing = connection.close();
    release.resolve();
    await Promise.allSettled([pending, closing]);
    expect(gate.inFlight).toBe(0);
  });

  it.runIf(process.platform === "win32")(
    "round-trips through the built stdio child with the official client",
    async () => {
    const entrypoint = resolve(process.cwd(), "dist", "src", "mcp", "stdio-server.js");
    const env = await isolatedChildEnvironment();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: process.cwd(),
      env,
      stderr: "pipe",
      maxBufferSize: STDIO_MAX_BUFFER_BYTES,
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const client = new Client({ name: "stdio-contract-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(transport.pid).toBeTypeOf("number");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        GAME_BRIDGE_TOOL_NAME,
      ]);

      const describeRequest = request("stdio-describe", "bridge.describe", {});
      const describeResult = await callBridge(client, describeRequest);
      const described = parseBridgeResponse(describeResult);
      expect(described).toMatchObject({
        requestId: describeRequest.requestId,
        action: describeRequest.action,
        mode: describeRequest.mode,
        ok: true,
      });
      expect(JSON.parse(textContent(describeResult))).toEqual(described);

      const opened = parseBridgeResponse(
        await callBridge(
          client,
          request("stdio-open", "session.open", {
            adapterId: "mock-world",
            capabilities: ["game.observe", "game.act.move", "safety.stop"],
          }),
        ),
      );
      expect(opened.ok).toBe(true);
      const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
      const committedRequest = request(
        "stdio-commit",
        "game.act",
        {
          adapterId: "mock-world",
          gameAction: "move",
          input: { dx: 1, dy: 0, dz: 0 },
          expectedRevision: 0,
        },
        { sessionId },
      );
      const committed = parseBridgeResponse(await callBridge(client, committedRequest));
      expect(parseBridgeResponse(await callBridge(client, committedRequest))).toEqual(
        committed,
      );
      const observed = parseBridgeResponse(
        await callBridge(
          client,
          request(
            "stdio-observe",
            "game.observe",
            { adapterId: "mock-world" },
            { sessionId },
          ),
        ),
      );
      expect(observed.ok && observed.result).toMatchObject({
        player: { x: 1, y: 1, z: 0 },
      });
    } finally {
      await client.close();
      await transport.close();
    }
    expect(stderr).toBe("");
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed on an oversized stdio frame without leaking its payload",
    async () => {
    const entrypoint = resolve(process.cwd(), "dist", "src", "mcp", "stdio-server.js");
    const env = await isolatedChildEnvironment();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: process.cwd(),
      env,
      stderr: "pipe",
      maxBufferSize: STDIO_MAX_BUFFER_BYTES,
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const client = new Client({ name: "stdio-limit-test", version: "1.0.0" });
    const injectedSecret = "Bearer-stdio-frame-secret-123";
    let outcome = "";

    try {
      await client.connect(transport);
      try {
        const result = await client.callTool(
          {
            name: GAME_BRIDGE_TOOL_NAME,
            arguments: toolArguments(
              request("stdio-oversize", "bridge.describe", {
                payload: injectedSecret.repeat(3_000),
              }),
            ),
          },
          { timeout: 1_000 },
        );
        outcome = JSON.stringify(result);
      } catch (error) {
        outcome = error instanceof Error ? error.message : "fixed client error";
      }
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }

    expect(outcome).not.toContain(injectedSecret);
    expect(stderr).not.toContain(injectedSecret);
    expect(stderr).toBe("Local MCP stdio transport error.\n");
    },
  );

  it.runIf(process.platform === "win32")(
    "fails product startup closed on corrupt committed audit bytes with a fixed error",
    async () => {
      const entrypoint = resolve(process.cwd(), "dist", "src", "mcp", "stdio-server.js");
      const env = await isolatedChildEnvironment();
      const ledgerDirectory = join(
        env.USERPROFILE!,
        "AppData",
        "Local",
        "xiaoqie-game-bridge-audit",
        "ledger",
      );
      await mkdir(ledgerDirectory, { recursive: true });
      const injected = "Bearer-corrupt-ledger-secret";
      await writeFile(join(ledgerDirectory, "segment-0001.audit"), injected);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint],
        cwd: process.cwd(),
        env,
        stderr: "pipe",
        maxBufferSize: STDIO_MAX_BUFFER_BYTES,
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const client = new Client({ name: "corrupt-ledger-test", version: "1.0.0" });
      await expect(client.connect(transport)).rejects.toThrow("Connection closed");
      await transport.close().catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      expect(stderr).toBe("Local audit ledger startup failed.\n");
      expect(stderr).not.toContain(injected);
      expect(stderr).not.toContain(ledgerDirectory);
    },
  );
});
