import type { GameAdapter } from "./adapter.js";

export class AdapterRegistry {
  readonly #adapters = new Map<string, GameAdapter>();

  register(adapter: GameAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): GameAdapter | undefined {
    return this.#adapters.get(adapterId);
  }

  list(): GameAdapter[] {
    return [...this.#adapters.values()];
  }

  capabilitiesFor(adapterId: string): Set<string> | undefined {
    const adapter = this.get(adapterId);
    if (adapter === undefined) {
      return undefined;
    }
    return new Set([
      adapter.observationCapability,
      "safety.stop",
      ...Object.values(adapter.actions).map((action) => action.capability),
    ]);
  }
}
