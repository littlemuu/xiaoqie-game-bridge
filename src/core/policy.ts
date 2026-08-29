import type { GameAdapter } from "./adapter.js";

export type PolicyDecision =
  | { allowed: true; parsedInput: unknown; capability: string }
  | {
      allowed: false;
      code: "ACTION_NOT_ALLOWED" | "INVALID_PARAMS" | "CAPABILITY_DENIED";
      message: string;
    };

export class PolicyEngine {
  authorizeGameAction(
    adapter: GameAdapter,
    action: string,
    input: unknown,
    capabilities: ReadonlySet<string>,
  ): PolicyDecision {
    const definition = adapter.actions[action];
    if (definition === undefined) {
      return {
        allowed: false,
        code: "ACTION_NOT_ALLOWED",
        message: "The requested game action is not registered by this adapter.",
      };
    }
    if (!capabilities.has(definition.capability)) {
      return {
        allowed: false,
        code: "CAPABILITY_DENIED",
        message: "The session does not grant the required action capability.",
      };
    }
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        allowed: false,
        code: "INVALID_PARAMS",
        message: "The game action parameters do not match the declared schema.",
      };
    }
    return {
      allowed: true,
      parsedInput: parsed.data,
      capability: definition.capability,
    };
  }
}
