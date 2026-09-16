import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { MinecraftJournal } from "../src/adapters/minecraft/journal.js";
import { LocalRcon } from "../src/adapters/minecraft/rcon.js";
import { MinecraftAdapter, parseMinecraftState } from "../src/adapters/minecraft/minecraft-adapter.js";
import { initMinecraft } from "../src/adapters/minecraft/config.js";
import { minecraftDatapack } from "../src/adapters/minecraft/datapack.js";
import { startMinecraftWireFixture } from "./fixtures/minecraft-rcon-server.js";
import { AdapterRegistry, GameBridge, SafetyLatch, MockGameAdapter } from "../src/index.js";
import { responseEnvelopeSchema, type BridgeResponse } from "../src/core/protocol.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const key = (value: string) => createHash("sha256").update(value).digest("hex");
async function directory() { const path = await mkdtemp(join(tmpdir(), "xqb-minecraft-")); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; }
async function fixture() {
  const root = await directory();
  const server = await startMinecraftWireFixture(); cleanup.push(() => server.close());
  let journal = new MinecraftJournal(root, 123);
  let adapter = new MinecraftAdapter(new LocalRcon(server.port, "a".repeat(64), 500), journal);
  cleanup.push(() => { adapter.close(); journal.close(); });
  await adapter.start();
  return { root, server, get journal() { return journal; }, get adapter() { return adapter; },
    async restart() { adapter.close(); journal.close(); journal = new MinecraftJournal(root, 123); adapter = new MinecraftAdapter(new LocalRcon(server.port, "a".repeat(64), 500), journal); await adapter.start(); },
  };
}
function execution(requestId = "one", expectedRevision = 0) { return { requestKey: key(requestId), expectedRevision, canDispatch: () => true }; }
async function bridgeFor(adapter: MinecraftAdapter) {
  const registry = new AdapterRegistry(); registry.register(adapter);
  const safetyLatch = new SafetyLatch(); safetyLatch.stop();
  const bridge = new GameBridge({ registry, safetyLatch, grantProvider: { grant: request => ({ allowed: true, capabilities: request.requestedCapabilities, scope: { kind: adapter.id, resourceId: "world-123" }, ttlMs: 900_000, totalActionBudget: 2, perActionBudgets: { set_marker: 2 } }) } });
  const call = (action: string, params: Record<string, unknown>, sessionId?: string, mode: "commit" | "dry-run" = "commit", requestId: string = randomUUID()) => bridge.handle({ protocolVersion: "1.0", requestId, action, params, mode, ...(sessionId ? { sessionId } : {}) }, { transport: "local" });
  const opened = await call("session.open", { adapterId: adapter.id, capabilities: ["game.observe", "game.act.set_marker", "safety.stop"] });
  if (!opened.ok) throw new Error("Session failed.");
  const sessionId = (opened.result as { sessionId: string }).sessionId;
  const act = (color: unknown, revision = 0, mode: "commit" | "dry-run" = "commit", requestId?: string) => call("game.act", { adapterId: adapter.id, gameAction: "set_marker", input: { color }, expectedRevision: revision }, sessionId, mode, requestId);
  return { bridge, safetyLatch, call, sessionId, act };
}
function errorCode(response: { ok: true } | { ok: false; error: { code: string } }) { return response.ok ? undefined : response.error.code; }

describe("Minecraft adapter over actual loopback RCON sockets (fixture, not game evidence)", () => {
  it("previews without side effects; enforces startup stop, exact catalog, revisions, idempotency and budget", async () => {
    const f = await fixture(); const b = await bridgeFor(f.adapter);
    expect(await b.call("bridge.describe", {}, undefined, "dry-run")).toMatchObject({ ok: true });
    expect(await b.act("lime", 0, "dry-run")).toMatchObject({ ok: true, result: { applied: false, stateRevision: 0 } });
    expect(f.journal.entries()).toHaveLength(0); expect(f.server.writes).toBe(0);
    expect(errorCode(await b.act("lime"))).toBe("SAFETY_STOPPED");
    await b.bridge.createLocalControlPlane().resumeSafety(1);
    expect(errorCode(await b.act("stone\nstop"))).toBe("INVALID_PARAMS");
    const id = randomUUID(); const applied = await b.act("lime", 0, "commit", id);
    expect(applied).toMatchObject({ ok: true, result: { applied: true, stateRevision: 1, color: "lime" } });
    expect(await b.act("lime", 0, "commit", id)).toEqual(applied);
    expect(f.server.writes).toBe(1); expect(f.journal.latest()?.status).toBe("applied");
    expect(errorCode(await b.act("blue", 0))).toBe("REVISION_CONFLICT");
    expect(await b.act("blue", 1)).toMatchObject({ ok: true });
    expect(errorCode(await b.act("gold", 2))).toBe("RESOURCE_CAPACITY");
    await f.restart(); expect(f.journal.entries()).toHaveLength(2);
    expect(await f.adapter.observe()).toMatchObject({ color: "blue", stateRevision: 2 });
  });

  it.each(["drop-after", "drop-before"] as const)("persists unknown %s, fences late delivery and reconciles after restart", async fault => {
    const f = await fixture(); const b = await bridgeFor(f.adapter);
    await b.bridge.createLocalControlPlane().resumeSafety(1); f.server.fault = fault;
    const unknown = await b.act("gold");
    expect(unknown).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN", operationPhase: "outcome-unknown", operationId: f.journal.pending()?.operationId } });
    expect(responseEnvelopeSchema.safeParse(unknown).success).toBe(true);
    expect(errorCode(await b.act("gold"))).toBe("RUNTIME_UNAVAILABLE");
    f.server.fault = "none"; await f.restart();
    expect(await f.adapter.reconcile()).toMatchObject({ status: fault === "drop-after" ? "applied" : "rejected" });
    f.server.deliverLate(); expect(f.server.writes).toBe(fault === "drop-after" ? 1 : 0);
    expect(f.journal.pending()).toBeUndefined(); await f.restart();
  });

  it("does not claim success if the server save fails", async () => {
    const f = await fixture(); f.server.fault = "save";
    await expect(f.adapter.execute("set_marker", { color: "lime" }, "commit", execution())).rejects.toMatchObject({ kind: "outcome-unknown" });
    expect(f.server.writes).toBe(1); expect(f.journal.pending()).toBeDefined();
    f.server.fault = "none"; await f.restart(); await f.adapter.reconcile(); expect(f.server.writes).toBe(1);
  });

  it("leaves a recoverable intent when local permission is revoked before the command is sent", async () => {
    const f = await fixture();
    await expect(f.adapter.execute("set_marker", { color: "blue" }, "commit", { ...execution(), canDispatch: () => false })).rejects.toMatchObject({ kind: "outcome-unknown" });
    expect(f.server.writes).toBe(0); await f.adapter.reconcile(); expect(f.journal.latest()?.status).toBe("rejected");
  });

  it("rejects world identity/history mismatch and malformed or unauthenticated RCON without raw text", async () => {
    const f = await fixture(); f.server.state.world = 456;
    await expect(f.adapter.observe()).rejects.toMatchObject({ kind: "unavailable" });
    f.server.state.world = 123; f.server.state.last = 4;
    await expect(f.adapter.start()).rejects.toThrow("histories disagree");
    f.server.fault = "malformed";
    await expect(f.adapter.observe()).rejects.toMatchObject({ kind: "unavailable" });
    const denied = new LocalRcon(f.server.port, "b".repeat(64), 100);
    await expect(denied.command("data get storage xqb:state state")).rejects.toThrow(/authentication/); denied.close();
    expect(() => parseMinecraftState('{world:123,revision:0,last:0,status:0,color:0,password:"secret"}')).toThrow();
  });

  it("bounds durable history, rejects conflicting request keys, and prevents simultaneous runtimes", async () => {
    const f = await fixture();
    expect(() => new MinecraftJournal(f.root, 123)).toThrow(/locked/);
    await f.adapter.execute("set_marker", { color: "lime" }, "commit", execution());
    await expect(f.adapter.execute("set_marker", { color: "blue" }, "commit", execution("one", 1))).rejects.toMatchObject({ code: "REQUEST_KEY_REUSED" });
    for (let i = 1; i < 512; i++) { const op = f.journal.begin(key(`capacity-${i}`), 1, "lime"); f.journal.finish(op.operationId, "rejected", 1); }
    f.server.state.last = 512;
    await expect(f.adapter.execute("set_marker", { color: "blue" }, "commit", execution("full", 1))).rejects.toMatchObject({ code: "JOURNAL_FULL" });
    expect(f.server.writes).toBe(1);
  });
});

describe("Minecraft local persistence and setup", () => {
  it.skipIf(process.platform === "win32")("runs the built Minecraft MCP entry with the official stdio client and keeps resume off the tool surface", async () => {
    const root = await directory(); const server = await startMinecraftWireFixture(); cleanup.push(() => server.close());
    await cp(resolve("dist/src"), join(root, "dist/src"), { recursive: true });
    await cp(resolve("package.json"), join(root, "package.json"));
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    await mkdir(join(root, ".minecraft-playtest"));
    await writeFile(join(root, ".minecraft-playtest/bridge-config.json"), JSON.stringify({ version: 1, world: 123, rconPort: server.port, password: "a".repeat(64) }));
    for (const allowWrites of [false, true]) {
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/src/mcp/minecraft-stdio.js"), ...(allowWrites ? ["--allow-writes"] : [])], cwd: root, stderr: "pipe" });
      let stderr = ""; transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const client = new Client({ name: "minecraft-wire-acceptance", version: "1.0.0" });
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["game_bridge_request"]);
        const call = async (action: string, params: Record<string, unknown>, sessionId?: string) => {
          const response = await client.callTool({ name: "game_bridge_request", arguments: { protocolVersion: "1.0", requestId: randomUUID(), action, params, mode: "commit", ...(sessionId ? { sessionId } : {}) } });
          return responseEnvelopeSchema.parse(response.structuredContent);
        };
        const opened = await call("session.open", { adapterId: "minecraft-marker", capabilities: ["game.observe", "game.act.set_marker", "safety.stop"] });
        expect(opened.ok).toBe(true);
        const sessionId = (opened as { result: { sessionId: string } }).result.sessionId;
        expect(errorCode(await call("safety.resume", {}, sessionId))).toBe("UNKNOWN_ACTION");
        const response = await call("game.act", { adapterId: "minecraft-marker", gameAction: "set_marker", input: { color: "lime" }, expectedRevision: 0 }, sessionId);
        expect(response.ok).toBe(allowWrites);
        if (!allowWrites) expect(errorCode(response)).toBe("SAFETY_STOPPED");
        expect(stderr).not.toContain("a".repeat(64));
      } finally { await client.close(); }
    }
    expect(server.writes).toBe(1);
  });

  it("recovers a committed intent and releases the OS lock after a real child-process kill", async () => {
    const root = await directory();
    const module = pathToFileURL(resolve("dist/src/adapters/minecraft/journal.js")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { MinecraftJournal } from ${JSON.stringify(module)}; const journal = new MinecraftJournal(${JSON.stringify(root)}, 123); journal.begin('${key("crash")}', 0, 'blue'); process.kill(process.pid, 'SIGKILL');`], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    const journal = new MinecraftJournal(root, 123); cleanup.push(() => journal.close());
    expect(journal.pending()).toMatchObject({ color: "blue", status: "intent" });
  });

  it("creates only a fresh local test directory, leaves EULA unaccepted, and refuses overwrite", async () => {
    const parent = await directory(); const root = join(parent, "playtest");
    await initMinecraft(root);
    expect(await readFile(join(root, "eula.txt"), "utf8")).toContain("eula=false");
    const properties = await readFile(join(root, "server.properties"), "utf8");
    expect(properties).toContain("server-ip=127.0.0.1"); expect(properties).toContain("online-mode=true");
    await expect(initMinecraft(root)).rejects.toThrow();
    const pack = minecraftDatapack(123);
    expect(JSON.parse(pack["pack.mcmeta"]!).pack.pack_format).toBe(26);
    for (const color of ["lime", "gold", "blue"]) {
      const fn = pack[`data/xqb/functions/set_${color}.mcfunction`]!;
      expect(fn.indexOf("state.last")).toBeLessThan(fn.indexOf("run setblock"));
      expect(fn).toContain("{revision:$(expected)}"); expect(fn).not.toMatch(/\$\((?:command|path|x|y|z)\)/);
    }
    expect(pack["data/xqb/functions/reconcile.mcfunction"]).not.toContain("setblock");
  });

  it("refuses a corrupted operation database", async () => {
    const root = await directory(); const journal = new MinecraftJournal(root, 123); journal.close();
    await writeFile(join(root, "operations.sqlite"), "broken");
    expect(() => new MinecraftJournal(root, 123)).toThrow(/corrupt/);
  });

  it("stops a core write when stop arrives during awaited revision lookup", async () => {
    const adapter = new MockGameAdapter(); const original = adapter.getStateRevision.bind(adapter);
    let signal!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    adapter.getStateRevision = async () => { signal(); await held; return original(); };
    const registry = new AdapterRegistry(); registry.register(adapter); const latch = new SafetyLatch();
    const bridge = new GameBridge({ registry, safetyLatch: latch });
    const opened = await bridge.handle({ protocolVersion: "1.0", requestId: "open", action: "session.open", params: { adapterId: "mock-world", capabilities: ["game.act.move"] }, mode: "commit" }, { transport: "local" });
    if (!opened.ok) throw new Error("open failed");
    const pending = bridge.handle({ protocolVersion: "1.0", requestId: "move", sessionId: (opened.result as { sessionId: string }).sessionId, action: "game.act", params: { adapterId: "mock-world", gameAction: "move", input: { dx: 1, dy: 0, dz: 0 }, expectedRevision: 0 }, mode: "commit" }, { transport: "local" });
    await entered; latch.stop(); release(); expect(errorCode(await pending)).toBe("SAFETY_STOPPED"); expect(await original()).toBe(0);
  });
});
