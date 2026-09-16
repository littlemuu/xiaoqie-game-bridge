import { z } from "zod";
import { AdapterExecutionError, AdapterRuntimeError, defineAdapterSchema, type AdapterExecutionOptions, type GameAdapter, type AdapterActionDefinition, type AdapterObservationDefinition } from "../../core/adapter.js";
import type { BridgeMode } from "../../core/protocol.js";
import { colors, MinecraftJournal, type Operation, type MarkerColor, MAX_OPERATIONS } from "./journal.js";
import { LocalRcon } from "./rcon.js";

const MAX_REVISION = 2_000_000_000;
const stateSchema = z.object({ world: z.number().int().min(1).max(MAX_REVISION), revision: z.number().int().min(0).max(MAX_REVISION), last: z.number().int().min(0).max(MAX_OPERATIONS), status: z.union([z.literal(-1), z.literal(0), z.literal(1)]), color: z.number().int().min(0).max(3) }).strict();
type State = z.infer<typeof stateSchema>;
const schema = (value: z.ZodType) => defineAdapterSchema(JSON.parse(JSON.stringify(z.toJSONSchema(value, { metadata: z.registry() }))));
const revision = z.number().int().min(0).max(MAX_REVISION);
const inputSchema = z.object({ color: z.enum(colors) }).strict();
const operationIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const resultSchema = z.object({ applied: z.boolean(), stateRevision: revision, color: z.enum(colors), operationId: operationIdSchema.optional() }).strict();
const observationSchema = z.object({ stateRevision: revision, color: z.enum(["white", ...colors]), position: z.object({ x: z.literal(0), y: z.literal(81), z: z.literal(0) }).strict(), observedAt: z.string().max(32), pendingOperationId: operationIdSchema.nullable(), source: z.literal("minecraft-java-1.20.4"), untrustedText: z.literal("omitted") }).strict();
const blockNames = ["white_wool", "lime_wool", "gold_block", "blue_wool"] as const;

/** Parse only a flat closed integer SNBT receipt. Never forward game text or command errors. */
export function parseMinecraftState(response: string): State {
  if (Buffer.byteLength(response) > 1_024) throw new Error("Invalid Minecraft receipt.");
  const match = /\{([^{}]*)\}\s*$/.exec(response);
  if (!match) throw new Error("Minecraft data pack is unavailable.");
  const object: Record<string, number> = {};
  for (const field of match[1]!.split(",")) {
    const pair = /^\s*(world|revision|last|status|color)\s*:\s*(-?[0-9]+)\s*$/.exec(field);
    if (!pair || Object.hasOwn(object, pair[1]!)) throw new Error("Invalid Minecraft receipt.");
    object[pair[1]!] = Number(pair[2]);
  }
  return stateSchema.parse(object);
}

export class MinecraftAdapter implements GameAdapter {
  readonly id = "minecraft-marker";
  readonly displayName = "Minecraft Java: one-block test pad";
  readonly observation: AdapterObservationDefinition = {
    description: "Read the fixed test marker and its version; game text is omitted.", outputSchema: schema(observationSchema), effectKind: "read", concurrency: { kind: "resource-serial", resourceKey: "marker" }, requiredCapabilities: ["game.observe"], maxResultBytes: 2_048,
  };
  readonly actions: Readonly<Record<string, AdapterActionDefinition>> = {
    set_marker: {
      description: "Change only the test marker at (0,81,0) to lime, gold or blue; journaled and game-verified.", inputSchema: schema(inputSchema), outputSchema: schema(resultSchema), effectKind: "write", dryRunSemantics: "best-effort", requiredCapabilities: ["game.act.set_marker"], maxResultBytes: 2_048, writeConcurrency: { kind: "resource-serial", resourceKey: "marker" }, adapterErrorCodes: ["MARKER_REJECTED", "OPERATION_PENDING", "REQUEST_KEY_REUSED", "JOURNAL_FULL"], requiresExpectedRevision: true, reconciliation: "supported",
    },
  };
  #available = true;
  #closed = false;
  constructor(readonly rcon: LocalRcon, readonly journal: MinecraftJournal) {}

  async #state(verifyBlock = true): Promise<State> {
    try {
      const state = parseMinecraftState(await this.rcon.command("data get storage xqb:state state"));
      if (state.world !== this.journal.world) throw new Error("World mismatch.");
      if (verifyBlock) {
        const verified = parseMinecraftState(await this.rcon.command(`execute in minecraft:overworld if block 0 81 0 minecraft:${blockNames[state.color]} run data get storage xqb:state state`));
        if (JSON.stringify(state) !== JSON.stringify(verified)) throw new Error("Marker changed while observing.");
      }
      this.#available = true;
      return state;
    } catch {
      this.#available = false;
      throw new AdapterRuntimeError("unavailable");
    }
  }

  async start(): Promise<void> {
    const state = await this.#state();
    const latest = this.journal.latest();
    const expectedLast = latest?.sequence ?? 0;
    if (state.last !== expectedLast && !(latest?.status === "intent" && state.last === expectedLast - 1)) throw new Error("Game and journal histories disagree.");
    if (latest !== undefined && latest.status !== "intent" && state.revision !== latest.resultRevision) throw new Error("Game revision disagrees with durable history.");
    if (latest === undefined && state.revision !== 0) throw new Error("Game has no matching local history.");
  }

  async observe(): Promise<unknown> {
    const state = await this.#state();
    return { stateRevision: state.revision, color: ["white", ...colors][state.color], position: { x: 0, y: 81, z: 0 }, observedAt: new Date().toISOString(), pendingOperationId: this.journal.pending()?.operationId ?? null, source: "minecraft-java-1.20.4", untrustedText: "omitted" };
  }
  async getStateRevision(): Promise<number> { return (await this.#state()).revision; }

  async execute(action: string, raw: unknown, mode: BridgeMode, options: AdapterExecutionOptions = {}): Promise<unknown> {
    if (action !== "set_marker") throw new AdapterRuntimeError("unavailable");
    const input = inputSchema.parse(raw);
    const state = await this.#state();
    if (mode === "dry-run") return { applied: false, stateRevision: state.revision, color: input.color };
    if (options.expectedRevision !== state.revision) throw new AdapterExecutionError("REVISION_CONFLICT");
    if (!options.requestKey || !options.canDispatch || this.#closed) throw new AdapterRuntimeError("unavailable");
    const previous = this.journal.find(options.requestKey);
    if (previous) {
      if (previous.color !== input.color || previous.expectedRevision !== options.expectedRevision) throw new AdapterExecutionError("REQUEST_KEY_REUSED");
      if (previous.status === "intent") throw new AdapterRuntimeError("outcome-unknown", "dispatched", previous.operationId);
      if (previous.status === "rejected") throw new AdapterExecutionError("MARKER_REJECTED");
      return this.#result(previous);
    }
    if (this.journal.pending()) throw new AdapterExecutionError("OPERATION_PENDING");
    if ((this.journal.latest()?.sequence ?? 0) >= MAX_OPERATIONS || state.revision >= MAX_REVISION) throw new AdapterExecutionError("JOURNAL_FULL");
    if (state.last !== (this.journal.latest()?.sequence ?? 0)) throw new AdapterRuntimeError("unavailable");
    let operation: Operation;
    try { operation = this.journal.begin(options.requestKey, options.expectedRevision, input.color); }
    catch { throw new AdapterRuntimeError("unavailable"); }
    // From durable intent onward, conservatively leave unresolved on *any* interruption.
    // Reconciliation fences even commands that arrive after the recovery connection.
    try {
      await this.rcon.command(`function xqb:set_${input.color} {world:${this.journal.world},sequence:${operation.sequence},expected:${options.expectedRevision},next:${options.expectedRevision + 1}}`, options.canDispatch);
      return await this.#settle(operation);
    } catch (error) {
      if (error instanceof AdapterExecutionError) throw error;
      throw new AdapterRuntimeError("outcome-unknown", "dispatched", operation.operationId);
    }
  }

  async #flush(): Promise<void> {
    const result = await this.rcon.command("save-all flush");
    if (!result.includes("Saved the game")) throw new Error("Minecraft did not confirm durable save.");
  }
  async #settle(operation: Operation): Promise<unknown> {
    await this.#flush();
    const state = await this.#state(false);
    if (state.last !== operation.sequence || (state.status !== 1 && state.status !== -1)) throw new Error("Operation receipt missing.");
    if (state.status === 1) {
      if (state.revision !== operation.expectedRevision + 1 || state.color !== colors.indexOf(operation.color) + 1) throw new Error("Operation receipt inconsistent.");
      await this.#state(); // Actual block evidence, not only the server-side receipt.
      this.journal.finish(operation.operationId, "applied", state.revision);
      return { applied: true, stateRevision: state.revision, color: operation.color, operationId: operation.operationId };
    }
    this.journal.finish(operation.operationId, "rejected", state.revision);
    throw new AdapterExecutionError("MARKER_REJECTED");
  }
  #result(operation: Operation): unknown {
    return { applied: true, stateRevision: operation.resultRevision, color: operation.color, operationId: operation.operationId };
  }

  /** Local operator only. This fences an unreceived operation; it never repeats its effect. */
  async reconcile(): Promise<{ operationId: string; status: string } | { status: "none" }> {
    const operation = this.journal.pending();
    if (!operation) return { status: "none" };
    const state = await this.#state(false);
    if (state.last !== operation.sequence && state.last !== operation.sequence - 1) throw new Error("Cannot reconcile divergent histories.");
    await this.rcon.command(`function xqb:reconcile {world:${this.journal.world},sequence:${operation.sequence}}`);
    try { await this.#settle(operation); }
    catch (error) { if (!(error instanceof AdapterExecutionError)) throw error; }
    return { operationId: operation.operationId, status: this.journal.latest()!.status };
  }

  health(): "ready" | "unavailable" { return !this.#closed && this.#available ? "ready" : "unavailable"; }
  close(): void { this.#closed = true; this.rcon.close(); }
}
