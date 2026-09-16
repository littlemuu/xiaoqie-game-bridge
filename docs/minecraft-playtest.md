# Minecraft 展示台：本地试玩与恢复

状态：代码已实现，工程回归通过；真实 Minecraft 与 Windows 新入口尚未完成验收。首次试玩请先运行末尾的验收命令。

## 1. 支持什么

只支持 **Minecraft Java Edition 1.20.4 专用服务器**，不是基岩版、Realms 或单人局域网开放模式。采用这一固定版本是为了约束数据包格式和命令语义，不表示它是最新版本。

运行环境：Node 22.18+（22.x）、Java 17。本项目使用 Node 内置 `node:sqlite`；Node 22 会输出实验性 API 提醒到 stderr。没有新增运行时 npm 包。

在新建的 `.minecraft-playtest/world` 中，数据包生成 7×7 光滑石地台，中央 `(0,81,0)` 初始为白色羊毛；将出生点设在台边，并强制加载涉及的四个区块。运行中的 `set_marker` 仅将中央方块改为绿色羊毛、金块或蓝色羊毛。

不要将此数据包安装到已有存档。初始化目录已存在时程序拒绝覆盖，不自动升级已有世界或删除历史。

## 2. 初始化和启动

从仓库根目录：

```bash
npm ci
npm run build
npm run minecraft -- init
npm run minecraft -- download-server
```

下载命令只从 Mojang 的固定 HTTPS 地址取 Java 1.20.4 jar，拒绝重定向和超过 64 MiB 的响应，并核对官方对象 SHA-1：`8dd1a28015f51b1803213892b50b7b4fc76e594d`。该摘要用于固定官方对象，并非抗恶意供应链的独立证明。已有 `server.jar` 不覆盖。

网络不支持自动下载时，可以从 [官方 1.20.4 发布页](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-4) 的 server jar 链接手动下载，放到 `.minecraft-playtest/server.jar`。版本必须匹配；不要替换为下载首页的最新版本。数据包格式 26 来源见 [官方 1.20.3 技术说明](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-3)。

阅读 [Minecraft EULA](https://www.minecraft.net/en-us/eula)，由你自行把 `.minecraft-playtest/eula.txt` 中的 `eula=false` 改为 `eula=true`。初始化和下载都不会代替你接受条款；未确认时启动命令拒绝运行。

终端 A：

```bash
npm run minecraft -- server
```

只启动固定 `java -Xms512M -Xmx1G -jar server.jar nogui`，工作目录固定为测试目录。程序不安装 Java、不登录账号、不打开 launcher、不设置服务或开机启动。服务器控制台本身可能显示本地用户名或游戏日志，不要整段贴到公共工单。

等待 `Done`，再等几秒让区块和展示台初始化。服务默认绑定 `127.0.0.1`，游戏端口 `25565`，RCON 端口 `25575`；RCON 使用随机 32 字节十六进制口令。`server.properties` 与 `bridge-config.json` 中的口令需要保持一致；不要将它们提交到仓库。保留 `online-mode=true`。

终端 B：

```bash
npm run minecraft -- play
```

Minecraft Java 1.20.4 客户端连接 `127.0.0.1:25565`。如果在 WSL 内运行服务器，优先把 bridge 与服务器放在同一个环境；本轮未验证 Windows/WSL 的跨环境 localhost 转发。不能连接时不要通过开放公网端口绕过。

## 3. 交互终端

| 命令 | 行为 |
| --- | --- |
| `observe` | 查询实际方块、颜色和版本，省略聊天、牌子、书本等文本 |
| `resume` | 本地人工启用本次进程写入；有待对账动作时拒绝 |
| `preview lime` / `preview gold` / `preview blue` | 返回预计颜色和当前版本，不记录 intent、不写游戏 |
| `commit` | 消耗刚才的预览，用该版本执行一次；之后必须重新预览 |
| `stop` | 关闸并清除当前预览 |
| `status` | 查看安全状态及待对账操作 ID |
| `quit` | 关闸、等待有界动作完成并释放资源 |
| Ctrl+C | 等待动作时立即关闸并开始退出；不承诺回滚已派发动作 |

建议第一次依次输入 `observe`、`resume`、`preview lime`、`commit`、`observe`。每个 session 最多 16 次写动作，TTL 15 分钟；用完或过期后退出并重新进入。重启仍默认 stopped。

## 4. MCP 请求

MCP client 拉起：

```text
node /absolute/repository/dist/src/mcp/minecraft-stdio.js
```

仅本地用户决定启用写入时，给启动参数增加 `--allow-writes`。不要同时启动 `play` 和 MCP；SQLite lifetime lock 只允许一个 runtime。默认 MCP 入口锁定写入，任何重启均重新应用启动设置。

Windows MCP 会启动已有独立 operator，支持 `npm run operator -- status` / `stop` / `resume --generation N`；该新组合仍需 Windows 实测。Linux 首版没有独立 operator IPC；模型 stop 后退出 client，在本地决定是否带写入参数重新启动。

恰好一个 tool：`game_bridge_request`。首次用 `bridge.describe` 看目录，再打开 session：

```json
{"protocolVersion":"1.0","requestId":"open-1","action":"session.open","params":{"adapterId":"minecraft-marker","capabilities":["game.observe","game.act.set_marker","safety.stop"]},"mode":"commit"}
```

把返回的真实 `sessionId` 填入后续请求。观察：

```json
{"protocolVersion":"1.0","requestId":"observe-1","sessionId":"返回的sessionId","action":"game.observe","params":{"adapterId":"minecraft-marker"},"mode":"dry-run"}
```

预览：

```json
{"protocolVersion":"1.0","requestId":"preview-1","sessionId":"返回的sessionId","action":"game.act","params":{"adapterId":"minecraft-marker","gameAction":"set_marker","input":{"color":"gold"}},"mode":"dry-run"}
```

用户授权写入后，以预览返回的真实版本执行（下面的 `0` 仅是初始示例值）：

```json
{"protocolVersion":"1.0","requestId":"write-1","sessionId":"返回的sessionId","action":"game.act","params":{"adapterId":"minecraft-marker","gameAction":"set_marker","input":{"color":"gold"},"expectedRevision":0},"mode":"commit"}
```

正常同 session 重放同一 requestId 返回缓存，不重复副作用。跨进程不恢复 session；原始请求 ID 只以可信 owner + requestId 摘要存入专用操作库。旧版本在 core 被拒绝，即使旧操作已经成功也不会自动重放。**结果未知时，不要改用新 requestId 再做一次。**

本轮没有创建或修改 ChatGPT Developer mode、Tunnel 或其他 host 配置；这是本地 stdio 入口。

## 5. 结果未知与恢复

成功的路径是：

1. 在 SQLite 以 `synchronous=FULL` 提交 intent，分配内部 UUID 和单调操作序号。
2. 固定 RCON 命令调用对应颜色的数据包函数。
3. 游戏函数核验世界、旧操作序号和 expected revision，检查原方块后修改单块，记录版本及回执。
4. 确认 `save-all flush`，读取回执并核对实际方块。
5. 将 result 提交到 SQLite，再向调用方报告成功。

若第 2–5 步无法确认，返回 `OUTCOME_UNKNOWN` 及 `operationId`，intent 保留，core fault 后拒绝新写。即使在 intent 后、命令发出前停止，也保守要求一次对账。

退出 `play` 或 MCP，使运行锁释放，再执行：

```bash
npm run minecraft -- reconcile
npm run minecraft -- status
npm run minecraft -- play
```

`reconcile` 使用原序号：已经有回执则核对并落盘；尚未收到的操作只提升服务端序号、记录明确拒绝，使迟到的旧命令失效。不会重新执行方块动作。之后观察，再决定是否 `resume`。重复对账且无 pending 时返回 `none`。

SQLite lifetime lock 由另一个数据库上的 OS 锁保持；正常退出或进程崩溃自动释放，不需要删除 PID 文件。服务端和本地操作库必须成套保留；不要单独删除数据库、回档世界、复制旧配置覆盖新实例，或把数据库当缓存清理。

每个测试世界容量 512 条操作，达到容量拒绝新动作。首版没有归档/清理功能，不能删库来复用序号。需要更多容量时保留完整测试目录，在新的独立 checkout 初始化另一个测试世界；两个世界不能同时占用默认端口。

## 6. 限制与失败处理

| 情况 | 处理 |
| --- | --- |
| 目录已经存在 | 保留现有目录；继续其中的配置，不重复 init |
| 服务未启动、口令或端口不匹配 | 检查两个本地配置及服务控制台，不输出口令 |
| 展示台尚未初始化 | 等待已强制加载的区块就绪后再连接 |
| SQLite runtime 已占用 | 先正常退出另一份 bridge；不要删除数据库或锁文件 |
| outcome unknown | 退出 bridge，运行 reconcile，观察后再启用 |
| 世界 ID、历史、实际方块或数据库不一致 | 拒绝继续写，保留目录用于诊断；首版不提供强制覆盖/自动修复 |
| 玩家手动破坏展示台 | 会使实际方块与回执不一致；不要把此状态当作网络重试处理 |

RCON 在服务端拥有管理权限。模型虽然只能走固定窄命令，但可信 host/adapter 自身没有被沙箱化；本入口没有复用 Windows Restricted Token + Job Object。随机世界标识只用于降低接错测试实例的概率，不是账号认证。

游戏函数在服务端串行命令执行中完成，但 Minecraft 保存涉及多个文件。`save-all flush` 能提供服务端保存确认，不能证明突然断电/存储故障下多个文件原子提交。检测到分歧时停写；不承诺跨重启 exactly-once、无条件恢复或敌对同用户防护。

该 adapter 专用 journal 已实现实际需要的 intent/result/reconciliation；这不是通用插件 operation database。Minecraft 的普通诊断使用最多 256 条内存环形记录，安全关键操作由独立 SQLite 记录。原 mock ledger/containment 不变。

## 7. 真机验收

服务运行、没有另一份 bridge 时执行：

```bash
npm run minecraft -- verify
```

它会真的把展示台改为绿色再蓝色，并运行：观察、无副作用预览、默认 stopped、真实修改、同 ID 重放、stale revision、真实命令后主动丢失确认、禁止新写、bridge 关闭重开对账、最终蓝色实物验证与重启 stopped。

这条命令不测试关闭 Minecraft 服务端、断电或磁盘写坏；这些需要额外受控环境。目前尚未运行真实游戏，因此没有真机 PASS 回执。普通测试使用真实 TCP/SQLite/stdio 连接到协议夹具，明确不冒充 Minecraft 实测。
