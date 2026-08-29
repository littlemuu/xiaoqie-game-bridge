export interface LocalSafetyControlPlane {
  resume(): { resumed: boolean };
}

export class SafetyLatch {
  #stopped = false;

  isStopped(): boolean {
    return this.#stopped;
  }

  stop(): { stopped: true; alreadyStopped: boolean } {
    const alreadyStopped = this.#stopped;
    this.#stopped = true;
    return { stopped: true, alreadyStopped };
  }

  createLocalControlPlane(): LocalSafetyControlPlane {
    return Object.freeze({
      resume: () => {
        const resumed = this.#stopped;
        this.#stopped = false;
        return { resumed };
      },
    });
  }
}
