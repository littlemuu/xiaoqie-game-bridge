import { ProcessMockAdapter } from "../adapters/mock/process-mock-adapter.js";
import { DurableAuditLedger } from "../audit/durable-ledger.js";
import { AdapterRegistry } from "../core/adapter-registry.js";
import { GameBridge, type BridgeLocalControlPlane } from "../core/bridge.js";
import { SafetyLatch } from "../core/safety-latch.js";

export interface ProductRuntime {
  adapter: ProcessMockAdapter;
  audit: DurableAuditLedger;
  bridge: GameBridge;
  control: BridgeLocalControlPlane;
  registry: AdapterRegistry;
  safetyLatch: SafetyLatch;
  close(): Promise<void>;
}

export const PRODUCT_MUTATION_DRAIN_MS = 1_000;

interface ProductCloseComponents {
  bridge: Pick<GameBridge, "beginQuiescing" | "waitForMutationsIdle">;
  adapter: Pick<ProcessMockAdapter, "close">;
  audit: Pick<DurableAuditLedger, "close">;
  mutationDrainMs?: number;
}

async function waitBounded(promise: Promise<void>, milliseconds: number): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new RangeError("mutationDrainMs must be a positive safe integer.");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function closeProductRuntimeComponents(
  components: ProductCloseComponents,
): Promise<void> {
  components.bridge.beginQuiescing();
  const drainMs = components.mutationDrainMs ?? PRODUCT_MUTATION_DRAIN_MS;
  await waitBounded(components.bridge.waitForMutationsIdle(), drainMs);

  let adapterFailure: unknown;
  try {
    await components.adapter.close();
  } catch (error) {
    adapterFailure = error;
  }
  await waitBounded(components.bridge.waitForMutationsIdle(), drainMs);

  let auditFailure: unknown;
  try {
    await components.audit.close();
  } catch (error) {
    auditFailure = error;
  }
  if (adapterFailure !== undefined) throw adapterFailure;
  if (auditFailure !== undefined) throw auditFailure;
}

export async function createProductRuntime(): Promise<ProductRuntime> {
  const registry = new AdapterRegistry();
  const audit = await DurableAuditLedger.open();
  let adapter: ProcessMockAdapter | undefined;
  try {
    adapter = new ProcessMockAdapter();
    await adapter.start();
  } catch (error) {
    if (adapter !== undefined) await adapter.close().catch(() => undefined);
    await audit.close().catch(() => undefined);
    throw error;
  }
  if (adapter === undefined) throw new Error("Contained adapter startup did not complete.");
  const safetyLatch = new SafetyLatch();
  registry.register(adapter);
  const bridge = new GameBridge({ registry, auditSink: audit, safetyLatch });
  const control = bridge.createLocalControlPlane();
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    adapter,
    audit,
    bridge,
    control,
    registry,
    safetyLatch,
    close: () => {
      closePromise ??= closeProductRuntimeComponents({ bridge, adapter, audit });
      return closePromise;
    },
  });
}
