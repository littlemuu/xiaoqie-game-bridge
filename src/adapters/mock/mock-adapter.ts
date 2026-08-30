import { z } from "zod";
import {
  AdapterExecutionError,
  type AdapterActionDefinition,
  type GameAdapter,
} from "../../core/adapter.js";
import type { BridgeMode } from "../../core/protocol.js";

const coordinateSchema = z.number().int().min(-8).max(8);
const heightSchema = z.number().int().min(0).max(4);
export const mockMoveInputSchema = z
  .object({
    dx: z.number().int().min(-1).max(1),
    dy: z.number().int().min(-1).max(1),
    dz: z.number().int().min(-1).max(1),
  })
  .strict()
  .refine(({ dx, dy, dz }) => dx !== 0 || dy !== 0 || dz !== 0);
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
  readonly observationCapability = "game.observe";
  readonly actions: Readonly<Record<string, AdapterActionDefinition>> = {
    move: {
      description: "Move the mock player by at most one unit per axis.",
      capability: "game.act.move",
      inputSchema: mockMoveInputSchema,
    },
    place_block: {
      description: "Place one allowlisted block inside the mock-world bounds.",
      capability: "game.act.place_block",
      inputSchema: mockPlaceBlockInputSchema,
    },
  };

  readonly #state: MockWorldState = {
    player: { x: 0, y: 1, z: 0 },
    blocks: new Map(),
  };

  constructor(id = "mock-world") {
    this.id = id;
  }

  async observe(): Promise<unknown> {
    return {
      player: clonePosition(this.#state.player),
      nearbyBlocks: [...this.#state.blocks.entries()]
        .map(([coordinates, blockType]) => ({ coordinates, blockType }))
        .sort((a, b) => a.coordinates.localeCompare(b.coordinates)),
    };
  }

  async execute(action: string, input: unknown, mode: BridgeMode): Promise<unknown> {
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
      throw new AdapterExecutionError("OUT_OF_BOUNDS", "The requested move leaves the mock world.");
    }
    if (mode === "commit") {
      this.#state.player = to;
    }
    return {
      applied: mode === "commit",
      change: { type: "move", from, to },
    };
  }

  #placeBlock(input: z.infer<typeof mockPlaceBlockInputSchema>, mode: BridgeMode): unknown {
    const position = { x: input.x, y: input.y, z: input.z };
    const key = blockKey(position);
    if (this.#state.blocks.has(key)) {
      throw new AdapterExecutionError("TARGET_OCCUPIED", "The mock-world target is occupied.");
    }
    if (mode === "commit") {
      this.#state.blocks.set(key, input.blockType);
    }
    return {
      applied: mode === "commit",
      change: { type: "place_block", position, blockType: input.blockType },
    };
  }
}
