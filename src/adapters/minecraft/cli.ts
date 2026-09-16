import { createHash, randomUUID } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { initMinecraft, minecraftRoot } from "./config.js";
import { createMinecraftRuntime } from "../../runtime/minecraft-runtime.js";
import { PROTOCOL_VERSION, type BridgeResponse } from "../../core/protocol.js";
import { colors, type MarkerColor } from "./journal.js";
import { verifyMinecraft } from "./verify.js";
import { downloadMinecraftServer, SERVER_SHA1 } from "./download.js";

function result(response: BridgeResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`${response.error.code}${response.error.operationId ? ` (${response.error.operationId})` : ""}`);
  return response.result as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("本地入口不接受额外路径、主机或命令参数。");
  if (command === "init") {
    await initMinecraft();
    process.stdout.write("测试目录已创建：.minecraft-playtest\n下一步：npm run minecraft -- download-server。阅读并自行确认 eula.txt 后，再执行 npm run minecraft -- server。\n");
    return;
  }
  if (command === "download-server") {
    try { await downloadMinecraftServer(); } catch {
      process.stderr.write("官方下载未完成：检查网络、是否已经有 server.jar，或从试玩指南的官方 1.20.4 链接手动下载。已有文件不会覆盖。\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write("官方 Java 1.20.4 server.jar 已下载并校验；未启动游戏，未接受 EULA。\n");
    return;
  }
  if (command === "server") {
    if (!/^eula=true\s*$/m.test(await readFile(join(minecraftRoot, "eula.txt"), "utf8"))) throw new Error("请先阅读 Minecraft EULA，并自行在 eula.txt 中确认接受。");
    const jar = await lstat(join(minecraftRoot, "server.jar"));
    if (!jar.isFile() || jar.isSymbolicLink() || jar.size > 64 * 1_024 * 1_024) throw new Error("缺少官方 server.jar。");
    if (createHash("sha1").update(await readFile(join(minecraftRoot, "server.jar"))).digest("hex") !== SERVER_SHA1) throw new Error("server.jar 与官方 Java 1.20.4 对象不匹配。");
    const server = spawn("java", ["-Xms512M", "-Xmx1G", "-jar", "server.jar", "nogui"], { cwd: minecraftRoot, stdio: "inherit", shell: false });
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new Error("无法启动 Java；需要 Java 17 和官方 1.20.4 server.jar。")));
      server.once("exit", code => { process.exitCode = code ?? 1; resolve(); });
    });
    return;
  }
  if (command === "verify") {
    process.stdout.write(JSON.stringify(await verifyMinecraft(), null, 2) + "\n");
    return;
  }
  if (!["status", "reconcile", "play"].includes(command ?? "")) {
    process.stdout.write("用法：npm run minecraft -- init|download-server|server|status|reconcile|play|verify\n");
    return;
  }
  const runtime = await createMinecraftRuntime();
  const call = (action: string, params: Record<string, unknown>, mode: "commit" | "dry-run" = "dry-run", sessionId?: string) => runtime.bridge.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), action, params, mode, ...(sessionId ? { sessionId } : {}) }, { transport: "local" });
  const opened = result(await call("session.open", { adapterId: "minecraft-marker", capabilities: ["game.observe", "game.act.set_marker", "safety.stop"] }, "commit"));
  const sessionId = opened.sessionId as string;
  const observe = async () => result(await call("game.observe", { adapterId: "minecraft-marker" }, "dry-run", sessionId));
  let reader: ReturnType<typeof createInterface> | undefined;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    runtime.safetyLatch.stop();
    reader?.close();
    void runtime.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    if (command === "status") {
      process.stdout.write(JSON.stringify({ health: runtime.bridge.getHealthStatus(), observation: await observe(), operations: runtime.journal.entries() }, null, 2) + "\n");
    } else if (command === "reconcile") {
      process.stdout.write(JSON.stringify(await runtime.adapter.reconcile()) + "\n写入仍保持锁定。请重新启动后观察，再决定是否恢复。\n");
    } else {
      reader = createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write("Minecraft 展示台：只修改 (0,81,0) 一块方块。\n命令：observe / preview lime|gold|blue / commit / resume / stop / status / quit\n启动时写入已锁定。先 observe，再 resume，然后 preview 和 commit。\n");
      let preview: { color: MarkerColor; revision: number } | undefined;
      while (!stopping) {
        const line = (await reader.question("game-bridge> ").catch(() => "quit")).trim();
        if (line === "quit") break;
        try {
          if (line === "observe") { process.stdout.write(JSON.stringify(await observe()) + "\n"); }
          else if (line === "status") { process.stdout.write(JSON.stringify({ health: runtime.bridge.getHealthStatus(), pending: runtime.journal.pending()?.operationId ?? null }) + "\n"); }
          else if (line === "stop") { preview = undefined; process.stdout.write(JSON.stringify(await runtime.control.stopSafety()) + "\n"); }
          else if (line === "resume") {
            if (runtime.journal.pending()) throw new Error("有待对账动作：退出后运行 reconcile，再重新进入。");
            process.stdout.write(JSON.stringify(await runtime.control.resumeSafety(runtime.safetyLatch.status().stopGeneration)) + "\n");
          } else if (line.startsWith("preview ") && colors.includes(line.slice(8) as MarkerColor)) {
            const color = line.slice(8) as MarkerColor;
            const response = result(await call("game.act", { adapterId: "minecraft-marker", gameAction: "set_marker", input: { color } }, "dry-run", sessionId));
            preview = { color, revision: response.stateRevision as number };
            process.stdout.write(`预览：把展示台方块改为 ${color}；版本 ${preview.revision}。输入 commit 执行。\n`);
          } else if (line === "commit") {
            if (!preview) throw new Error("先 preview 一个颜色。");
            const selected = preview; preview = undefined;
            process.stdout.write(JSON.stringify(result(await call("game.act", { adapterId: "minecraft-marker", gameAction: "set_marker", input: { color: selected.color }, expectedRevision: selected.revision }, "commit", sessionId))) + "\n");
          } else { process.stdout.write("未知命令。使用 observe、preview lime|gold|blue、commit、resume、stop、status、quit。\n"); }
        } catch (error) {
          // Only our fixed errors / stable bridge codes are emitted, never raw RCON or secrets.
          process.stdout.write(`${error instanceof Error ? error.message : "操作未完成。"}\n`);
        }
      }
    }
  } finally {
    reader?.close();
    process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown);
    await runtime.close();
  }
}

await main().catch(() => {
  process.stderr.write("Minecraft 本地操作未完成：检查测试目录是否已初始化、EULA 是否自行确认、Java 17/1.20.4 服务是否在线，以及是否已有 bridge 进程占用。原始错误与凭据未输出。\n");
  process.exitCode = 1;
});
