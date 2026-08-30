import type { z } from "zod";
import type { BridgeMode, ErrorCode } from "./protocol.js";

export interface AdapterActionDefinition {
  description: string;
  capability: string;
  inputSchema: z.ZodType<unknown>;
}

export interface AdapterDescription {
  id: string;
  displayName: string;
  observationCapability: string;
  actions: Record<string, Omit<AdapterActionDefinition, "inputSchema">>;
}

export interface GameAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly observationCapability: string;
  readonly actions: Readonly<Record<string, AdapterActionDefinition>>;
  observe(): Promise<unknown>;
  execute(action: string, input: unknown, mode: BridgeMode): Promise<unknown>;
}

export class AdapterExecutionError extends Error {
  constructor(
    readonly code: Extract<
      ErrorCode,
      "OUT_OF_BOUNDS" | "BLOCK_NOT_ALLOWED" | "TARGET_OCCUPIED"
    >,
    message: string,
  ) {
    super(message);
    this.name = "AdapterExecutionError";
  }
}

export function describeAdapter(adapter: GameAdapter): AdapterDescription {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    observationCapability: adapter.observationCapability,
    actions: Object.fromEntries(
      Object.entries(adapter.actions).map(([name, definition]) => [
        name,
        {
          description: definition.description,
          capability: definition.capability,
        },
      ]),
    ),
  };
}
