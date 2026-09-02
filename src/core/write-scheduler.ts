export interface ResourceWritePermit {
  release(): void;
}

export class ResourceWriteScheduler {
  readonly #active = new Set<string>();

  tryAcquire(resourceKey: string): ResourceWritePermit | undefined {
    if (this.#active.has(resourceKey)) return undefined;
    this.#active.add(resourceKey);
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#active.delete(resourceKey);
      },
    });
  }

  get inFlightResources(): number {
    return this.#active.size;
  }
}
