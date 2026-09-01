import { snapshotAdapter, type GameAdapter } from "./adapter.js";

export class AdapterRegistry {
  readonly #adapters = new Map<string, GameAdapter>();

  register(adapter: GameAdapter): void {
    const snapshot = snapshotAdapter(adapter);
    if (this.#adapters.has(snapshot.id)) {
      throw new Error(`Adapter already registered: ${snapshot.id}`);
    }
    this.#adapters.set(snapshot.id, snapshot);
  }

  get(adapterId: string): GameAdapter | undefined {
    return this.#adapters.get(adapterId);
  }

  list(): readonly GameAdapter[] {
    return [...this.#adapters.values()];
  }

  capabilitiesFor(adapterId: string): Set<string> | undefined {
    const adapter = this.get(adapterId);
    if (adapter === undefined) {
      return undefined;
    }
    return new Set([
      "safety.stop",
      ...adapter.observation.requiredCapabilities,
      ...Object.values(adapter.actions).flatMap((action) => action.requiredCapabilities),
    ]);
  }
}
