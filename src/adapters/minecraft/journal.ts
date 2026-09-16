import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const MAX_OPERATIONS = 512;
export const colors = ["lime", "gold", "blue"] as const;
export type MarkerColor = typeof colors[number];
const operationSchema = z.object({
  sequence: z.number().int().min(1).max(MAX_OPERATIONS),
  operationId: z.string().uuid(),
  requestKey: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.number().int().min(0).max(2_000_000_000),
  color: z.enum(colors),
  status: z.enum(["intent", "applied", "rejected"]),
  resultRevision: z.number().int().min(0).max(2_000_000_000).nullable(),
}).strict();
export type Operation = z.infer<typeof operationSchema>;

/** Operation evidence is separate from diagnostic audit. SQLite FULL commits precede dispatch.
 * A separate SQLite transaction provides an OS-released lifetime lock (including after crashes).
 * This is local accidental-failure protection, not protection against hostile same-user edits.
 */
export class MinecraftJournal {
  readonly #lock: DatabaseSync;
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(directory: string, readonly world: number) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Invalid journal directory.");
    const dbPath = join(directory, "operations.sqlite");
    const lockPath = join(directory, "runtime-lock.sqlite");
    for (const path of [dbPath, lockPath, `${dbPath}-journal`, `${lockPath}-journal`]) {
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 8 * 1_024 * 1_024)) {
        throw new Error("Invalid or oversized journal file.");
      }
    }
    this.#lock = new DatabaseSync(lockPath);
    let db: DatabaseSync | undefined;
    try {
      this.#lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;");
      db.exec("CREATE TABLE IF NOT EXISTS metadata (world INTEGER NOT NULL, version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS operations (sequence INTEGER PRIMARY KEY, operationId TEXT UNIQUE NOT NULL, requestKey TEXT UNIQUE NOT NULL, expectedRevision INTEGER NOT NULL, color TEXT NOT NULL, status TEXT NOT NULL, resultRevision INTEGER);");
      const metadata = db.prepare("SELECT * FROM metadata").all();
      if (metadata.length === 0) db.prepare("INSERT INTO metadata VALUES (?, 1)").run(world);
      else if (metadata.length !== 1 || metadata[0]!.world !== world || metadata[0]!.version !== 1) throw new Error("Journal world/version mismatch.");
      const integrity = db.prepare("PRAGMA quick_check").get();
      if (integrity?.quick_check !== "ok") throw new Error("Journal integrity failure.");
      this.#db = db;
      const entries = this.entries();
      if (entries.length > MAX_OPERATIONS || entries.some((entry, i) => entry.sequence !== i + 1 || (entry.status === "intent" && i !== entries.length - 1) || (entry.status === "intent") !== (entry.resultRevision === null))) {
        throw new Error("Journal history is inconsistent.");
      }
      chmodSync(dbPath, 0o600);
      chmodSync(lockPath, 0o600);
    } catch {
      db?.close();
      this.#lock.close();
      throw new Error("Minecraft journal is locked, corrupt, or incompatible.");
    }
  }

  entries(): Operation[] {
    return this.#db.prepare("SELECT * FROM operations ORDER BY sequence LIMIT 513").all().map(row => operationSchema.parse(row));
  }
  latest(): Operation | undefined { return this.entries().at(-1); }
  pending(): Operation | undefined { const entry = this.latest(); return entry?.status === "intent" ? entry : undefined; }
  find(requestKey: string): Operation | undefined {
    const row = this.#db.prepare("SELECT * FROM operations WHERE requestKey=?").get(requestKey);
    return row === undefined ? undefined : operationSchema.parse(row);
  }
  begin(requestKey: string, expectedRevision: number, color: MarkerColor): Operation {
    if (this.pending() !== undefined) throw new Error("An unresolved operation blocks writes.");
    const sequence = (this.latest()?.sequence ?? 0) + 1;
    const operation = operationSchema.parse({ sequence, operationId: randomUUID(), requestKey, expectedRevision, color, status: "intent", resultRevision: null });
    this.#db.prepare("INSERT INTO operations VALUES (?, ?, ?, ?, ?, 'intent', NULL)").run(sequence, operation.operationId, requestKey, expectedRevision, color);
    return operation;
  }
  finish(operationId: string, status: "applied" | "rejected", revision: number): void {
    const operation = this.pending();
    if (operation?.operationId !== operationId || !Number.isSafeInteger(revision) || revision < 0 || revision > 2_000_000_000) throw new Error("Invalid journal settlement.");
    this.#db.prepare("UPDATE operations SET status=?, resultRevision=? WHERE operationId=? AND status='intent'").run(status, revision, operationId);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } finally { this.#lock.close(); }
  }
}
