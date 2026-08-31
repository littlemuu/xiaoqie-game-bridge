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

export async function createProductRuntime(): Promise<ProductRuntime> {
  const registry = new AdapterRegistry();
  const audit = await DurableAuditLedger.open();
  let adapter: ProcessMockAdapter;
  try {
    adapter = new ProcessMockAdapter();
  } catch (error) {
    await audit.close().catch(() => undefined);
    throw error;
  }
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
      closePromise ??= (async () => {
        await audit.close();
        await adapter.close();
      })();
      return closePromise;
    },
  });
}
