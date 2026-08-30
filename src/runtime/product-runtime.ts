import { ProcessMockAdapter } from "../adapters/mock/process-mock-adapter.js";
import { AdapterRegistry } from "../core/adapter-registry.js";
import { MemoryAuditSink } from "../core/audit.js";
import { GameBridge, type BridgeLocalControlPlane } from "../core/bridge.js";
import { SafetyLatch } from "../core/safety-latch.js";

export interface ProductRuntime {
  adapter: ProcessMockAdapter;
  audit: MemoryAuditSink;
  bridge: GameBridge;
  control: BridgeLocalControlPlane;
  registry: AdapterRegistry;
  safetyLatch: SafetyLatch;
  close(): Promise<void>;
}

export function createProductRuntime(): ProductRuntime {
  const registry = new AdapterRegistry();
  const adapter = new ProcessMockAdapter();
  const audit = new MemoryAuditSink();
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
      closePromise ??= adapter.close();
      return closePromise;
    },
  });
}
