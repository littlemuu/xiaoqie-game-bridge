import { Buffer } from "node:buffer";
import {
  describeAdapter,
  snapshotAdapter,
  type GameAdapter,
} from "./adapter.js";

export const ADAPTER_REGISTRY_MAX_ADAPTERS = 64;
export const ADAPTER_REGISTRY_MAX_CATALOG_BYTES = 32 * 1_024;

export class AdapterRegistry {
  readonly #adapters = new Map<string, GameAdapter>();

  register(adapter: GameAdapter): void {
    if (this.#adapters.size >= ADAPTER_REGISTRY_MAX_ADAPTERS) {
      throw new RangeError("Adapter registry capacity is exhausted.");
    }
    const snapshot = snapshotAdapter(adapter);
    if (this.#adapters.has(snapshot.id)) {
      throw new Error(`Adapter already registered: ${snapshot.id}`);
    }
    const candidateCatalog = [
      ...this.#adapters.values(),
      snapshot,
    ].map(describeAdapter);
    if (
      Buffer.byteLength(JSON.stringify(candidateCatalog), "utf8") >
      ADAPTER_REGISTRY_MAX_CATALOG_BYTES
    ) {
      throw new RangeError("Adapter registry catalog capacity is exhausted.");
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
