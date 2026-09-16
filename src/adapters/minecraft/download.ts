import { createHash, randomUUID } from "node:crypto";
import { writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { minecraftRoot, readMinecraftConfig } from "./config.js";

// Official link published in Mojang's Java 1.20.4 release notes; not a moving latest URL.
export const SERVER_SHA1 = "8dd1a28015f51b1803213892b50b7b4fc76e594d";
const SERVER_URL = `https://piston-data.mojang.com/v1/objects/${SERVER_SHA1}/server.jar`;

export async function downloadMinecraftServer(): Promise<void> {
  await readMinecraftConfig();
  const response = await fetch(SERVER_URL, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || response.body === null) throw new Error("Official server download failed.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64 * 1_024 * 1_024) throw new Error("Official server download exceeded the size limit.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha1").update(bytes).digest("hex") !== SERVER_SHA1) throw new Error("Official server checksum mismatch.");
  const temporary = join(minecraftRoot, `server-download-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await link(temporary, join(minecraftRoot, "server.jar")); // Exclusive publication; never replaces a jar.
  } finally { await unlink(temporary).catch(() => undefined); }
}
