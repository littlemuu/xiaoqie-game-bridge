import { randomBytes, randomInt } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { minecraftDatapack } from "./datapack.js";

export const minecraftRoot = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../.minecraft-playtest/" : "../../../../.minecraft-playtest/", import.meta.url));
const configSchema = z.object({ version: z.literal(1), world: z.number().int().min(1).max(2_000_000_000), rconPort: z.number().int().min(1).max(65_535), password: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type MinecraftConfig = z.infer<typeof configSchema>;

export async function initMinecraft(root = minecraftRoot): Promise<void> {
  // Intentionally no recursive creation here: never overwrite an existing test world or secrets.
  await mkdir(root, { mode: 0o700 });
  const config: MinecraftConfig = { version: 1, world: randomInt(1, 2_000_000_000), rconPort: 25575, password: randomBytes(32).toString("hex") };
  await writeFile(join(root, "bridge-config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(root, "server.properties"), [
    "server-ip=127.0.0.1", "server-port=25565", "enable-rcon=true", "rcon.port=25575", `rcon.password=${config.password}`,
    "broadcast-rcon-to-ops=false", "online-mode=true", "enforce-secure-profile=true", "level-name=world", "level-type=minecraft:flat",
    'generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}',
    "gamemode=creative", "force-gamemode=true", "difficulty=peaceful", "spawn-protection=0", "spawn-animals=false", "spawn-monsters=false", "generate-structures=false", "max-players=2", "view-distance=4", "simulation-distance=4", "motd=Xiaoqie Game Bridge Playtest",
  ].join("\n") + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(root, "eula.txt"), "# Read https://www.minecraft.net/en-us/eula and accept yourself before running.\neula=false\n", { flag: "wx" });
  for (const [relative, content] of Object.entries(minecraftDatapack(config.world))) {
    const path = join(root, "world", "datapacks", "xiaoqie-bridge", relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  }
}

export async function readMinecraftConfig(root = minecraftRoot): Promise<MinecraftConfig> {
  const file = join(root, "bridge-config.json");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_048) throw new Error("Invalid Minecraft configuration.");
  return configSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
