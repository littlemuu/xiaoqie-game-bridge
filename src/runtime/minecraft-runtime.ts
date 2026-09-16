import { join } from "node:path";
import { AdapterRegistry } from "../core/adapter-registry.js";
import { GameBridge } from "../core/bridge.js";
import { SafetyLatch } from "../core/safety-latch.js";
import { MinecraftAdapter } from "../adapters/minecraft/minecraft-adapter.js";
import { MinecraftJournal } from "../adapters/minecraft/journal.js";
import { LocalRcon } from "../adapters/minecraft/rcon.js";
import { minecraftRoot, readMinecraftConfig } from "../adapters/minecraft/config.js";
import type { CapabilityGrantProvider } from "../core/grant.js";
import type { AuditEvent, AuditSink } from "../core/audit.js";

class BoundedDiagnosticAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  write(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > 256) this.events.shift();
  }
}

export async function createMinecraftRuntime(root = minecraftRoot) {
  const config = await readMinecraftConfig(root);
  const journal = new MinecraftJournal(join(root, "bridge-state"), config.world);
  const adapter = new MinecraftAdapter(new LocalRcon(config.rconPort, config.password), journal);
  try { await adapter.start(); } catch {
    adapter.close(); journal.close();
    throw new Error("Minecraft connection, world identity, or journal verification failed.");
  }
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const safetyLatch = new SafetyLatch({ maxInFlightWrites: 1 });
  safetyLatch.stop(); // A process restart never silently re-enables game writes.
  const grantProvider: CapabilityGrantProvider = {
    grant: request => request.context.transport !== "local" || request.adapter.id !== adapter.id ? { allowed: false } : {
      allowed: true,
      capabilities: request.requestedCapabilities.filter(cap => ["game.observe", "game.act.set_marker", "safety.stop"].includes(cap)),
      scope: { kind: "minecraft-marker", resourceId: `world-${config.world}` },
      ttlMs: Math.min(request.requestedTtlMs ?? 900_000, 900_000),
      totalActionBudget: 16,
      perActionBudgets: { set_marker: 16 },
    },
  };
  const bridge = new GameBridge({ registry, safetyLatch, grantProvider, auditSink: new BoundedDiagnosticAudit() });
  const control = bridge.createLocalControlPlane();
  let closing: Promise<void> | undefined;
  return {
    bridge, control, adapter, journal, safetyLatch,
    close(): Promise<void> {
      closing ??= (async () => {
        safetyLatch.stop(); bridge.beginQuiescing();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([bridge.waitForMutationsIdle(), new Promise<void>(resolve => { timer = setTimeout(resolve, 4_000); })]);
        } finally { if (timer) clearTimeout(timer); }
        adapter.close();
        await bridge.waitForMutationsIdle(); // Closing sockets settles bounded RCON commands.
        journal.close();
      })();
      return closing;
    },
  };
}
