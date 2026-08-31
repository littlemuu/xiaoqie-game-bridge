import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAuditLedger, AuditLedgerError } from "../src/audit/durable-ledger.js";
import { MockGameAdapter } from "../src/adapters/mock/mock-adapter.js";
import { AdapterRegistry } from "../src/core/adapter-registry.js";
import type { AuditEvent } from "../src/core/audit.js";
import { GameBridge } from "../src/core/bridge.js";
import { SafetyLatch } from "../src/core/safety-latch.js";

const temporaryDirectories = new Set<string>();

async function temporaryLedgerRoot(label: string): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), `xiaoqie-ledger-${label}-`));
  temporaryDirectories.add(parent);
  return { parent, root: join(parent, "ledger") };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      temporaryDirectories.delete(directory);
    }),
  );
});

function event(index = 1): AuditEvent {
  return {
    timestamp: "2026-08-31T00:00:00.000Z",
    callerTag: "0123456789ab",
    requestIdTag: createHash("sha256").update(`request-${index}`).digest("hex").slice(0, 12),
    sessionIdTag: "abcdef012345",
    adapterId: "mock-world",
    action: "game.act",
    mode: "commit",
    decision: "allow",
    safetyStopped: false,
    idempotencyHit: false,
    metadata: {
      safe: `event-${index}`,
      token: "review-secret-value",
      nested: { value: "Bearer credential-value", count: index },
      endpoint: "https://review.invalid/private",
      note: "https://value-injection.invalid/private",
      sourcePath: "C:\\Users\\ReviewUser\\save.dat",
      pid: 424242,
      username: "ReviewUser",
      stack: "attacker stack trace",
      rawPayload: "private world state",
    },
  };
}

interface DecodedRecord {
  sequence: number;
  previousDigest: string;
  digest: string;
  payload: { kind: string; event?: unknown; sourceSegments?: number[] };
}

function decodeFrames(bytes: Buffer): DecodedRecord[] {
  const records: DecodedRecord[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const size = Number.parseInt(bytes.subarray(offset, offset + 8).toString("ascii"), 16);
    const start = offset + 9;
    records.push(JSON.parse(bytes.subarray(start, start + size).toString("utf8")));
    offset = start + size + 1;
  }
  return records;
}

async function segmentBytes(root: string, index = 1): Promise<Buffer> {
  return readFile(join(root, `segment-${index.toString().padStart(4, "0")}.audit`));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function bridgeWithLedger(ledger: DurableAuditLedger, safetyLatch = new SafetyLatch()) {
  const registry = new AdapterRegistry();
  const adapter = new MockGameAdapter();
  registry.register(adapter);
  const bridge = new GameBridge({ registry, auditSink: ledger, safetyLatch });
  return { adapter, bridge, control: bridge.createLocalControlPlane(), safetyLatch };
}

describe("durable local audit ledger", () => {
  it("writes deterministic, strict, chained records and recursively removes sensitive values", async () => {
    const left = await temporaryLedgerRoot("deterministic-left");
    const right = await temporaryLedgerRoot("deterministic-right");
    const leftLedger = await DurableAuditLedger.open({ testOnly: { rootDirectory: left.root } });
    const rightLedger = await DurableAuditLedger.open({ testOnly: { rootDirectory: right.root } });

    await Promise.all([leftLedger.write(event()), rightLedger.write(event())]);
    await Promise.all([leftLedger.close(), rightLedger.close()]);

    const leftBytes = await segmentBytes(left.root);
    const rightBytes = await segmentBytes(right.root);
    expect(leftBytes.equals(rightBytes)).toBe(true);
    const text = leftBytes.toString("utf8");
    expect(text).not.toContain("review-secret-value");
    expect(text).not.toContain("credential-value");
    expect(text).not.toContain("review.invalid");
    expect(text).not.toContain("value-injection.invalid");
    expect(text).not.toContain("ReviewUser");
    expect(text).not.toContain("424242");
    expect(text).not.toContain("private world state");
    expect(text).not.toContain("mock-world");
    expect(text).not.toContain("session-secret-value");
    const [record] = decodeFrames(leftBytes);
    expect(record).toMatchObject({ sequence: 1, previousDigest: "0".repeat(64) });
    expect(record?.payload.kind).toBe("event");
  });

  it("serializes the bounded concurrent queue into a monotonic hash chain", async () => {
    const fixture = await temporaryLedgerRoot("concurrent");
    const ledger = await DurableAuditLedger.open({ testOnly: { rootDirectory: fixture.root } });
    await Promise.all(Array.from({ length: 8 }, (_, index) => ledger.write(event(index + 1))));
    await ledger.close();

    const records = decodeFrames(await segmentBytes(fixture.root));
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]?.previousDigest).toBe(records[index - 1]?.digest);
    }
  });

  it("verifies a clean restart and continues the existing chain", async () => {
    const fixture = await temporaryLedgerRoot("restart");
    const first = await DurableAuditLedger.open({ testOnly: { rootDirectory: fixture.root } });
    await first.write(event(1));
    await first.close();
    const second = await DurableAuditLedger.open({ testOnly: { rootDirectory: fixture.root } });
    await second.write(event(2));
    await second.close();
    expect(decodeFrames(await segmentBytes(fixture.root)).map((record) => record.sequence)).toEqual([
      1, 2,
    ]);
  });

  it("keeps resume stopped until the authorization record is synced", async () => {
    const fixture = await temporaryLedgerRoot("resume-pending");
    const gate = deferred();
    const ledger = await DurableAuditLedger.open({
      testOnly: { rootDirectory: fixture.root, beforeSync: () => gate.promise },
    });
    const safetyLatch = new SafetyLatch();
    const stopped = safetyLatch.stop();
    const { control } = bridgeWithLedger(ledger, safetyLatch);

    const resuming = control.resumeSafety(stopped.stopGeneration);
    await new Promise((resolve) => setImmediate(resolve));
    expect(control.getSafetyStatus().stopped).toBe(true);
    gate.resolve();
    await expect(resuming).resolves.toMatchObject({ resumed: true, stopped: false });
    await ledger.close();
  });

  it("fails resume closed on sync rejection and after an aborted late settlement", async () => {
    const rejectedFixture = await temporaryLedgerRoot("resume-reject");
    const rejected = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: rejectedFixture.root,
        beforeSync: () => Promise.reject(new Error("attacker-controlled-error")),
      },
    });
    const rejectedLatch = new SafetyLatch();
    const rejectedStop = rejectedLatch.stop();
    const rejectedControl = bridgeWithLedger(rejected, rejectedLatch).control;
    await expect(rejectedControl.resumeSafety(rejectedStop.stopGeneration)).rejects.toBeInstanceOf(
      AuditLedgerError,
    );
    expect(rejectedControl.getSafetyStatus().stopped).toBe(true);
    await rejected.close();

    const lateFixture = await temporaryLedgerRoot("resume-late");
    const gate = deferred();
    const late = await DurableAuditLedger.open({
      testOnly: { rootDirectory: lateFixture.root, beforeSync: () => gate.promise },
    });
    const lateLatch = new SafetyLatch();
    const lateStop = lateLatch.stop();
    const lateControl = bridgeWithLedger(late, lateLatch).control;
    const controller = new AbortController();
    const resuming = lateControl.resumeSafety(lateStop.stopGeneration, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(resuming).rejects.toThrow("local-control-aborted");
    gate.resolve();
    await lateControl.waitForAuditIdle();
    expect(lateControl.getSafetyStatus().stopped).toBe(true);
    await late.close();
  });

  it("applies stop before pending, rejected, or full audit acknowledgement", async () => {
    const pendingFixture = await temporaryLedgerRoot("stop-pending");
    const gate = deferred();
    const pending = await DurableAuditLedger.open({
      testOnly: { rootDirectory: pendingFixture.root, beforeSync: () => gate.promise },
    });
    const pendingControl = bridgeWithLedger(pending).control;
    const stopping = pendingControl.stopSafety();
    expect(pendingControl.getSafetyStatus().stopped).toBe(true);
    gate.resolve();
    await stopping;
    await pending.close();

    const rejectedFixture = await temporaryLedgerRoot("stop-rejected");
    const rejected = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: rejectedFixture.root,
        beforeAppend: () => Promise.reject(new Error("write-rejected")),
      },
    });
    const rejectedControl = bridgeWithLedger(rejected).control;
    await expect(rejectedControl.stopSafety()).rejects.toBeInstanceOf(AuditLedgerError);
    expect(rejectedControl.getSafetyStatus().stopped).toBe(true);
    await rejected.close();

    const fullFixture = await temporaryLedgerRoot("stop-full");
    const full = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: fullFixture.root,
        limits: { maxRecordBytes: 700, maxSegmentBytes: 700, maxSegments: 1 },
      },
    });
    await full.write({ ...event(1), metadata: undefined });
    await expect(full.write({ ...event(2), metadata: undefined })).rejects.toMatchObject({
      code: "capacity",
    });
    const fullControl = bridgeWithLedger(full).control;
    await expect(fullControl.stopSafety()).rejects.toMatchObject({ code: "capacity" });
    expect(fullControl.getSafetyStatus().stopped).toBe(true);
    await full.close();
  });

  it("preserves a torn tail, writes one recovery marker, and remains idempotent", async () => {
    const fixture = await temporaryLedgerRoot("torn");
    const original = await DurableAuditLedger.open({ testOnly: { rootDirectory: fixture.root } });
    await original.write(event(1));
    await original.write(event(2));
    await original.close();
    const complete = await segmentBytes(fixture.root);
    const firstFrameBytes = 9 + Number.parseInt(complete.subarray(0, 8).toString("ascii"), 16) + 1;
    const torn = complete.subarray(0, firstFrameBytes + 17);
    await writeFile(join(fixture.root, "segment-0001.audit"), torn);
    const preserved = Buffer.from(torn);

    const recovered = await DurableAuditLedger.open({ testOnly: { rootDirectory: fixture.root } });
    expect(recovered.health()).toMatchObject({ status: "degraded", segmentCount: 2 });
    await recovered.close();
    expect((await segmentBytes(fixture.root, 1)).equals(preserved)).toBe(true);
    expect(decodeFrames(await segmentBytes(fixture.root, 2))[0]?.payload).toMatchObject({
      kind: "recovery",
      sourceSegments: [1],
    });

    const restarted = await DurableAuditLedger.open({ testOnly: { rootDirectory: fixture.root } });
    await restarted.close();
    expect((await readdir(fixture.root)).sort()).toEqual([
      "segment-0001.audit",
      "segment-0002.audit",
    ]);
  });

  it("never accepts prefixes of a final frame as a confirmed record", async () => {
    const source = await temporaryLedgerRoot("truncation-source");
    const ledger = await DurableAuditLedger.open({ testOnly: { rootDirectory: source.root } });
    await ledger.write(event(1));
    await ledger.write(event(2));
    await ledger.close();
    const complete = await segmentBytes(source.root);
    const firstFrameBytes = 9 + Number.parseInt(complete.subarray(0, 8).toString("ascii"), 16) + 1;
    const everyFinalFrameCut = Array.from(
      { length: complete.byteLength - firstFrameBytes },
      (_, index) => firstFrameBytes + index,
    );
    for (const cut of everyFinalFrameCut) {
      const fixture = await temporaryLedgerRoot(`cut-${cut}`);
      await mkdir(fixture.root);
      await writeFile(join(fixture.root, "segment-0001.audit"), complete.subarray(0, cut));
      const reopened = await DurableAuditLedger.open({ testOnly: { rootDirectory: fixture.root } });
      expect(reopened.health().nextSequence).toBe(cut === firstFrameBytes ? 2 : 3);
      await reopened.close();
    }
  });

  it("fails closed on committed corruption, oversize, symlink, and directory replacement", async () => {
    const corruptFixture = await temporaryLedgerRoot("corrupt");
    const ledger = await DurableAuditLedger.open({ testOnly: { rootDirectory: corruptFixture.root } });
    await ledger.write(event());
    await ledger.close();
    const path = join(corruptFixture.root, "segment-0001.audit");
    const corrupt = await readFile(path);
    corrupt[Math.floor(corrupt.byteLength / 2)]! ^= 1;
    await writeFile(path, corrupt);
    const preserved = await readFile(path);
    await expect(
      DurableAuditLedger.open({ testOnly: { rootDirectory: corruptFixture.root } }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect((await readFile(path)).equals(preserved)).toBe(true);

    const canonicalFixture = await temporaryLedgerRoot("corruption-source");
    const canonicalLedger = await DurableAuditLedger.open({
      testOnly: { rootDirectory: canonicalFixture.root },
    });
    await canonicalLedger.write(event());
    await canonicalLedger.close();
    const canonical = await segmentBytes(canonicalFixture.root);
    const mutations = [
      (text: string) => text.replace('"formatVersion":1', '"formatVersion":2'),
      (text: string) => text.replace('"sequence":1', '"sequence":2'),
      (text: string) => text.replace('"previousDigest":"0', '"previousDigest":"1'),
    ];
    for (let index = 0; index < mutations.length; index += 1) {
      const mutationFixture = await temporaryLedgerRoot(`mutation-${index}`);
      await mkdir(mutationFixture.root);
      const mutated = Buffer.from(mutations[index]!(canonical.toString("utf8")), "utf8");
      await writeFile(join(mutationFixture.root, "segment-0001.audit"), mutated);
      const before = await segmentBytes(mutationFixture.root);
      await expect(
        DurableAuditLedger.open({ testOnly: { rootDirectory: mutationFixture.root } }),
      ).rejects.toMatchObject({ code: "corrupt" });
      expect((await segmentBytes(mutationFixture.root)).equals(before)).toBe(true);
    }

    const oversizeFixture = await temporaryLedgerRoot("oversize");
    await mkdir(oversizeFixture.root);
    await writeFile(join(oversizeFixture.root, "segment-0001.audit"), Buffer.alloc(1_025));
    await expect(
      DurableAuditLedger.open({
        testOnly: {
          rootDirectory: oversizeFixture.root,
          limits: { maxRecordBytes: 512, maxSegmentBytes: 1_024 },
        },
      }),
    ).rejects.toMatchObject({ code: "corrupt" });

    const linkFixture = await temporaryLedgerRoot("symlink");
    const target = join(linkFixture.parent, "target");
    await mkdir(target);
    await symlink(target, linkFixture.root, process.platform === "win32" ? "junction" : "dir");
    await expect(
      DurableAuditLedger.open({ testOnly: { rootDirectory: linkFixture.root } }),
    ).rejects.toMatchObject({ code: "object-identity" });

    const swapFixture = await temporaryLedgerRoot("swap");
    const swapped = await DurableAuditLedger.open({ testOnly: { rootDirectory: swapFixture.root } });
    try {
      await rename(swapFixture.root, `${swapFixture.root}-old`);
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error) {
        expect(error.code).toBe("EPERM");
        await swapped.close();
        return;
      }
      throw error;
    }
    await mkdir(swapFixture.root);
    await expect(swapped.write(event())).rejects.toMatchObject({ code: "object-identity" });
    expect(await readdir(swapFixture.root)).toEqual([]);
    await swapped.close();
  });

  it("enforces queue, record, segment, and shutdown bounds without retrying", async () => {
    const queueFixture = await temporaryLedgerRoot("queue-bound");
    const gate = deferred();
    const queueLedger = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: queueFixture.root,
        limits: { maxPendingWrites: 2 },
        beforeAppend: () => gate.promise,
      },
    });
    const first = queueLedger.write(event(1));
    const second = queueLedger.write(event(2));
    await expect(queueLedger.write(event(3))).rejects.toMatchObject({ code: "capacity" });
    expect(queueLedger.health().outstandingWrites).toBe(2);
    gate.resolve();
    await Promise.all([first, second]);
    await queueLedger.close();

    const recordFixture = await temporaryLedgerRoot("record-bound");
    const recordLedger = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: recordFixture.root,
        limits: { maxRecordBytes: 256, maxSegmentBytes: 512 },
      },
    });
    await expect(recordLedger.write(event())).rejects.toMatchObject({ code: "invalid-event" });
    await recordLedger.close();

    const shutdownFixture = await temporaryLedgerRoot("shutdown-bound");
    const never = new Promise<void>(() => undefined);
    const shutdownLedger = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: shutdownFixture.root,
        limits: { shutdownDrainMs: 25 },
        beforeSync: () => never,
      },
    });
    const pending = shutdownLedger.write(event());
    const abandonedReservation = shutdownLedger.reserveWrite();
    expect(abandonedReservation).toBeDefined();
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: "closed" });
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    await shutdownLedger.close();
    expect(Date.now() - started).toBeLessThan(250);
    await pendingRejection;
    await expect(abandonedReservation!.write(event(99))).rejects.toMatchObject({
      code: "closed",
    });
    expect(shutdownLedger.health()).toMatchObject({ status: "closed", outstandingWrites: 0 });
    const size = (await lstat(join(shutdownFixture.root, "segment-0001.audit"))).size;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await lstat(join(shutdownFixture.root, "segment-0001.audit"))).size).toBe(size);
  });

  it("rejects an ordinary commit without changing mock state after total capacity is full", async () => {
    const fixture = await temporaryLedgerRoot("commit-full");
    const ledger = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: fixture.root,
        limits: { maxRecordBytes: 1_024, maxSegmentBytes: 1_600, maxSegments: 1 },
      },
    });
    const { adapter, bridge } = bridgeWithLedger(ledger);
    const context = { transport: "local" } as const;
    const opened = await bridge.handle(
      {
        protocolVersion: "1.0",
        requestId: "capacity-open",
        action: "session.open",
        params: { adapterId: "mock-world", capabilities: ["game.observe", "game.act.move"] },
        mode: "commit",
      },
      context,
    );
    expect(opened.ok).toBe(true);
    const sessionId = opened.ok
      ? (opened.result as { sessionId: string }).sessionId
      : "unreachable";
    for (let index = 0; index < 8 && ledger.health().status !== "full"; index += 1) {
      await ledger.write(event(index + 20)).catch(() => undefined);
    }
    expect(ledger.health().status).toBe("full");

    const committed = await bridge.handle(
      {
        protocolVersion: "1.0",
        requestId: "capacity-commit",
        sessionId,
        action: "game.act",
        params: {
          adapterId: "mock-world",
          gameAction: "move",
          input: { dx: 1, dy: 0, dz: 0 },
        },
        mode: "commit",
      },
      context,
    );
    expect(committed).toMatchObject({ ok: false, error: { code: "RESOURCE_CAPACITY" } });
    await expect(adapter.observe()).resolves.toMatchObject({ player: { x: 0 } });
    await ledger.close();
  });

  it("atomically reserves the last audit slot before concurrent commit side effects", async () => {
    const fixture = await temporaryLedgerRoot("commit-reservation");
    const gate = deferred();
    let blockWrites = false;
    const ledger = await DurableAuditLedger.open({
      testOnly: {
        rootDirectory: fixture.root,
        limits: { maxPendingWrites: 2 },
        beforeAppend: () => (blockWrites ? gate.promise : undefined),
      },
    });
    const { adapter, bridge } = bridgeWithLedger(ledger);
    const context = { transport: "local" } as const;
    const opened = await bridge.handle(
      {
        protocolVersion: "1.0",
        requestId: "reservation-open",
        action: "session.open",
        params: { adapterId: "mock-world", capabilities: ["game.act.move"] },
        mode: "commit",
      },
      context,
    );
    expect(opened.ok).toBe(true);
    const sessionId = opened.ok
      ? (opened.result as { sessionId: string }).sessionId
      : "unreachable";
    blockWrites = true;
    const occupied = ledger.write(event(90));
    await new Promise((resolve) => setImmediate(resolve));
    const commit = (requestId: string) =>
      bridge.handle(
        {
          protocolVersion: "1.0",
          requestId,
          sessionId,
          action: "game.act",
          params: {
            adapterId: "mock-world",
            gameAction: "move",
            input: { dx: 1, dy: 0, dz: 0 },
          },
          mode: "commit",
        },
        context,
      );
    const accepted = commit("reservation-accepted");
    const refused = await commit("reservation-refused");
    expect(refused).toMatchObject({ ok: false, error: { code: "RESOURCE_CAPACITY" } });
    await expect(adapter.observe()).resolves.toMatchObject({ player: { x: 1 } });
    gate.resolve();
    await expect(accepted).resolves.toMatchObject({ ok: true });
    await occupied;
    await ledger.close();
  });
});
