export const DEFAULT_MAX_IN_FLIGHT_WRITES = 4;

export interface SafetyStatus {
  stopped: boolean;
  inFlightWrites: number;
  maxInFlightWrites: number;
  stopGeneration: number;
}

export type BeginWriteResult =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: "stopped" | "capacity" };

export interface SafetyLatchOptions {
  maxInFlightWrites?: number;
}

export type SafetyResumeFailureReason =
  | "generation-mismatch"
  | "not-stopped"
  | "resume-pending"
  | "stop-superseded"
  | "writes-in-flight";

export type SafetyResumeResult =
  | (SafetyStatus & { resumed: true })
  | (SafetyStatus & {
      resumed: false;
      reason: SafetyResumeFailureReason;
    });

function requirePositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("maxInFlightWrites must be a positive safe integer.");
  }
}

export class SafetyLatch {
  #stopped = false;
  #inFlightWrites = 0;
  #stopGeneration = 0;
  readonly #maxInFlightWrites: number;

  constructor(options: SafetyLatchOptions = {}) {
    this.#maxInFlightWrites =
      options.maxInFlightWrites ?? DEFAULT_MAX_IN_FLIGHT_WRITES;
    requirePositiveInteger(this.#maxInFlightWrites);
  }

  isStopped(): boolean {
    return this.#stopped;
  }

  stop(): SafetyStatus & { stopped: true; alreadyStopped: boolean } {
    const alreadyStopped = this.#stopped;
    if (!alreadyStopped) {
      this.#stopGeneration += 1;
    }
    this.#stopped = true;
    return { ...this.status(), stopped: true, alreadyStopped };
  }

  status(): SafetyStatus {
    return {
      stopped: this.#stopped,
      inFlightWrites: this.#inFlightWrites,
      maxInFlightWrites: this.#maxInFlightWrites,
      stopGeneration: this.#stopGeneration,
    };
  }

  resumeBlockReason(
    expectedGeneration: number,
  ): Exclude<SafetyResumeFailureReason, "resume-pending" | "stop-superseded"> | undefined {
    if (!this.#stopped) {
      return "not-stopped";
    }
    if (
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 1 ||
      expectedGeneration !== this.#stopGeneration
    ) {
      return "generation-mismatch";
    }
    if (this.#inFlightWrites > 0) {
      return "writes-in-flight";
    }
    return undefined;
  }

  resume(expectedGeneration: number): SafetyResumeResult {
    const reason = this.resumeBlockReason(expectedGeneration);
    if (reason !== undefined) {
      return { ...this.status(), resumed: false, reason };
    }
    this.#stopped = false;
    return { ...this.status(), resumed: true };
  }

  beginWrite(): BeginWriteResult {
    if (this.#stopped) {
      return { allowed: false, reason: "stopped" };
    }
    if (this.#inFlightWrites >= this.#maxInFlightWrites) {
      return { allowed: false, reason: "capacity" };
    }
    this.#inFlightWrites += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (!released) {
          released = true;
          this.#inFlightWrites -= 1;
        }
      },
    };
  }
}
