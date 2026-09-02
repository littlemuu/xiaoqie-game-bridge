import { z } from "zod";
import {
  AdapterExecutionError,
  type AdapterActionDefinition,
  type AdapterExecutionOptions,
  type AdapterObservationDefinition,
  type GameAdapter,
} from "../../core/adapter.js";
import type { BridgeMode } from "../../core/protocol.js";

const coordinateSchema = z.number().int().min(-8).max(8);
const heightSchema = z.number().int().min(0).max(4);
const deltaSchema = z.number().int().min(-1).max(1);
const nonZeroDeltaSchema = z.union([z.literal(-1), z.literal(1)]);
export const mockMoveInputSchema = z.union([
  z.object({ dx: nonZeroDeltaSchema, dy: deltaSchema, dz: deltaSchema }).strict(),
  z.object({ dx: z.literal(0), dy: nonZeroDeltaSchema, dz: deltaSchema }).strict(),
  z.object({ dx: z.literal(0), dy: z.literal(0), dz: nonZeroDeltaSchema }).strict(),
]);
export const mockPlaceBlockInputSchema = z
  .object({
    x: coordinateSchema,
    y: heightSchema,
    z: coordinateSchema,
    blockType: z.enum(["stone", "dirt", "torch"]),
  })
  .strict();

interface Position {
  x: number;
  y: number;
  z: number;
}

const positionSchema = z
  .object({
    x: coordinateSchema,
    y: heightSchema,
    z: coordinateSchema,
  })
  .strict();

export const mockObservationResultSchema = z
  .object({
    stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    player: positionSchema,
    nearbyBlocks: z.array(
      z
        .object({
          coordinates: z.string().regex(/^-?[0-8],[0-4],-?[0-8]$/),
          blockType: z.enum(["stone", "dirt", "torch"]),
        })
        .strict(),
    ),
  })
  .strict();

export const mockMoveResultSchema = z
  .object({
    applied: z.boolean(),
    stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    change: z
      .object({
        type: z.literal("move"),
        from: positionSchema,
        to: positionSchema,
      })
      .strict(),
  })
  .strict();

export const mockPlaceBlockResultSchema = z
  .object({
    applied: z.boolean(),
    stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    change: z
      .object({
        type: z.literal("place_block"),
        position: positionSchema,
        blockType: z.enum(["stone", "dirt", "torch"]),
      })
      .strict(),
  })
  .strict();

interface MockWorldState {
  player: Position;
  blocks: Map<string, string>;
}

function blockKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`;
}

function clonePosition(position: Position): Position {
  return { ...position };
}

export class MockGameAdapter implements GameAdapter {
  readonly id: string;
  readonly displayName = "Deterministic in-memory mock world";
  readonly observation: AdapterObservationDefinition = {
    description: "Observe the bounded mock player and nearby allowlisted blocks.",
    outputSchema: mockObservationResultSchema,
    effectKind: "read",
    concurrency: { kind: "parallel" },
    requiredCapabilities: ["game.observe"],
    maxResultBytes: 8 * 1_024,
  };
  readonly actions: Readonly<Record<string, AdapterActionDefinition>> = {
    move: {
      description: "Move the mock player by at most one unit per axis.",
      inputSchema: mockMoveInputSchema,
      outputSchema: mockMoveResultSchema,
      effectKind: "write",
      dryRunSemantics: "exact",
      requiredCapabilities: ["game.act.move"],
      maxResultBytes: 4 * 1_024,
      writeConcurrency: { kind: "resource-serial", resourceKey: "world" },
      adapterErrorCodes: ["OUT_OF_BOUNDS"],
      requiresExpectedRevision: true,
      reconciliation: "future",
    },
    place_block: {
      description: "Place one allowlisted block inside the mock-world bounds.",
      inputSchema: mockPlaceBlockInputSchema,
      outputSchema: mockPlaceBlockResultSchema,
      effectKind: "write",
      dryRunSemantics: "exact",
      requiredCapabilities: ["game.act.place_block"],
      maxResultBytes: 4 * 1_024,
      writeConcurrency: { kind: "resource-serial", resourceKey: "world" },
      adapterErrorCodes: ["BLOCK_NOT_ALLOWED", "TARGET_OCCUPIED"],
      requiresExpectedRevision: true,
      reconciliation: "future",
    },
  };

  readonly #state: MockWorldState = {
    player: { x: 0, y: 1, z: 0 },
    blocks: new Map(),
  };
  #stateRevision = 0;

  constructor(id = "mock-world") {
    this.id = id;
  }

  async observe(): Promise<unknown> {
    return {
      stateRevision: this.#stateRevision,
      player: clonePosition(this.#state.player),
      nearbyBlocks: [...this.#state.blocks.entries()]
        .map(([coordinates, blockType]) => ({ coordinates, blockType }))
        .sort((a, b) => a.coordinates.localeCompare(b.coordinates)),
    };
  }

  async getStateRevision(): Promise<number> {
    return this.#stateRevision;
  }

  async execute(
    action: string,
    input: unknown,
    mode: BridgeMode,
    options: AdapterExecutionOptions = {},
  ): Promise<unknown> {
    if (mode === "commit" && options.expectedRevision !== this.#stateRevision) {
      throw new AdapterExecutionError("REVISION_CONFLICT");
    }
    switch (action) {
      case "move":
        return this.#move(input as z.infer<typeof mockMoveInputSchema>, mode);
      case "place_block":
        return this.#placeBlock(input as z.infer<typeof mockPlaceBlockInputSchema>, mode);
      default:
        throw new Error("Policy allowed an unregistered mock action.");
    }
  }

  #move(input: z.infer<typeof mockMoveInputSchema>, mode: BridgeMode): unknown {
    const from = clonePosition(this.#state.player);
    const to = {
      x: from.x + input.dx,
      y: from.y + input.dy,
      z: from.z + input.dz,
    };
    if (Math.abs(to.x) > 8 || to.y < 0 || to.y > 4 || Math.abs(to.z) > 8) {
      throw new AdapterExecutionError("OUT_OF_BOUNDS");
    }
    if (mode === "commit") {
      this.#state.player = to;
      this.#stateRevision += 1;
    }
    return {
      applied: mode === "commit",
      stateRevision: this.#stateRevision,
      change: { type: "move", from, to },
    };
  }

  #placeBlock(input: z.infer<typeof mockPlaceBlockInputSchema>, mode: BridgeMode): unknown {
    const position = { x: input.x, y: input.y, z: input.z };
    const key = blockKey(position);
    if (this.#state.blocks.has(key)) {
      throw new AdapterExecutionError("TARGET_OCCUPIED");
    }
    if (mode === "commit") {
      this.#state.blocks.set(key, input.blockType);
      this.#stateRevision += 1;
    }
    return {
      applied: mode === "commit",
      stateRevision: this.#stateRevision,
      change: { type: "place_block", position, blockType: input.blockType },
    };
  }

  health(): "ready" {
    return "ready";
  }
}
