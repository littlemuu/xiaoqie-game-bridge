import { randomUUID } from "node:crypto";
import { createMinecraftRuntime } from "../../runtime/minecraft-runtime.js";
import type { BridgeResponse } from "../../core/protocol.js";

function requireSuccess(response: BridgeResponse): Record<string, unknown> {
  if (!response.ok) throw new Error("Live verification failed.");
  return response.result as Record<string, unknown>;
}
function check(value: unknown): asserts value { if (!value) throw new Error("Live verification failed."); }

/** Explicit local acceptance command. Changes the dedicated pad; never run by ordinary CI. */
export async function verifyMinecraft(): Promise<Record<string, boolean | string>> {
  let runtime = await createMinecraftRuntime();
  const call = (action: string, params: Record<string, unknown>, sessionId?: string, mode: "commit" | "dry-run" = "commit", requestId: string = randomUUID()) => runtime.bridge.handle({ protocolVersion: "1.0", requestId, action, params, mode, ...(sessionId ? { sessionId } : {}) }, { transport: "local" });
  const open = async () => (requireSuccess(await call("session.open", { adapterId: "minecraft-marker", capabilities: ["game.observe", "game.act.set_marker", "safety.stop"] })).sessionId as string);
  const params = (color: string, expectedRevision: number) => ({ adapterId: "minecraft-marker", gameAction: "set_marker", input: { color }, expectedRevision });
  try {
    check(runtime.journal.pending() === undefined);
    let session = await open();
    const before = requireSuccess(await call("game.observe", { adapterId: "minecraft-marker" }, session, "dry-run"));
    const revision = before.stateRevision as number;
    const preview = requireSuccess(await call("game.act", params("lime", revision), session, "dry-run"));
    check(preview.applied === false && preview.stateRevision === revision);
    const stopped = await call("game.act", params("lime", revision), session);
    check(!stopped.ok && stopped.error.code === "SAFETY_STOPPED");
    check((await runtime.control.resumeSafety(runtime.safetyLatch.status().stopGeneration)).resumed);
    const requestId = randomUUID();
    const applied = await call("game.act", params("lime", revision), session, "commit", requestId);
    check(requireSuccess(applied).stateRevision === revision + 1);
    check(JSON.stringify(await call("game.act", params("lime", revision), session, "commit", requestId)) === JSON.stringify(applied));
    const stale = await call("game.act", params("blue", revision), session);
    check(!stale.ok && stale.error.code === "REVISION_CONFLICT");
    // The real game executes this command; deliberately lose only the adapter's acknowledgement.
    const command = runtime.adapter.rcon.command.bind(runtime.adapter.rcon);
    let loseReply = true;
    runtime.adapter.rcon.command = async (text, beforeSend) => {
      const response = await command(text, beforeSend);
      if (loseReply && text.startsWith("function xqb:set_")) { loseReply = false; throw new Error("Controlled acknowledgement loss."); }
      return response;
    };
    const unknown = await call("game.act", params("blue", revision + 1), session);
    check(!unknown.ok && unknown.error.code === "OUTCOME_UNKNOWN" && unknown.error.operationId !== undefined);
    const operationId = runtime.journal.pending()!.operationId;
    const blocked = await call("game.act", params("gold", revision + 2), session);
    check(!blocked.ok && blocked.error.code === "RUNTIME_UNAVAILABLE");
    await runtime.close(); runtime = await createMinecraftRuntime();
    const reconciled = await runtime.adapter.reconcile();
    check(reconciled.status === "applied" && "operationId" in reconciled && reconciled.operationId === operationId);
    await runtime.close(); runtime = await createMinecraftRuntime(); session = await open();
    const after = requireSuccess(await call("game.observe", { adapterId: "minecraft-marker" }, session, "dry-run"));
    check(after.color === "blue" && after.stateRevision === revision + 2 && runtime.safetyLatch.isStopped());
    return { target: "Minecraft Java 1.20.4", observation: true, preview: true, startupStopped: true, realBlockWrite: true, duplicateSuppressed: true, staleRevisionRejected: true, acknowledgementLoss: true, pendingBlocksNewWrites: true, restartReconciliation: true, restartStopped: true, finalColor: "blue" };
  } finally { await runtime.close(); }
}
