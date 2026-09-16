# xiaoqie-game-bridge

让 AI 通过范围明确、随时可停的本地能力操作游戏。核心负责权限、session、版本检查、动作预算和急停；模型拿不到任意命令或电脑控制权。

**目前已实现 Minecraft Java 的第一个最小玩法：观察展示台 → 预览颜色 → 确认改变一块方块 → 验证结果。真实 Minecraft 验收尚待运行，当前不能标记为已验收可用版。**

| 路径 | 当前能力 | 验证边界 |
| --- | --- | --- |
| Minecraft 展示台 | 真实 RCON adapter、游戏数据包、本地 CLI / stdio MCP、持久动作记录及恢复 | 工程回归已通过；真实游戏与 Windows 新入口待验收 |
| 原 mock RC | Windows worker、本地 operator、持久安全审计、原模拟世界 | 保留既有平台与历史验收边界 |

当前 npm 元数据仍为 `0.1.0-rc.1`，仅沿用原 mock RC 发布基线；本次是未发布的源码增量，没有创建新版本 tag、Release 或扩大原 RC 的支持声明。

## 开始试玩 Minecraft

需要 Node.js **22.18+（22.x）**、Java **17**；游戏客户端和服务器均固定为 **Java Edition 1.20.4**。不适用于基岩版、Switch、Realms 或普通“对局域网开放”的单人世界。

在仓库根目录执行：

```bash
npm ci
npm run build
npm run minecraft -- init
npm run minecraft -- download-server
```

`init` 只创建新的 `.minecraft-playtest` 测试目录、随机连接凭据和数据包；目录已存在就拒绝覆盖。`download-server` 只下载并校验官方固定版本 jar。接着阅读 [Minecraft EULA](https://www.minecraft.net/en-us/eula)，自行在测试目录的 `eula.txt` 中确认接受。程序不会代为接受。

第一个终端：

```bash
npm run minecraft -- server
```

看到服务器启动完成后稍等展示台初始化。第二个终端：

```bash
npm run minecraft -- play
```

进入交互终端后，依次输入：

```text
observe
resume
preview lime
commit
observe
```

在 Minecraft Java 1.20.4 客户端中连接 `127.0.0.1:25565`，可以看到 `(0,81,0)` 的展示台方块改变颜色。初次生成会建立一块 7×7 地台并设置测试出生点；后续 bridge 动作只修改中央的一块方块。颜色可选 `lime`、`gold`、`blue`。`stop` 关闭写入，`quit` 退出；等待动作时按 Ctrl+C 立即关闸并开始退出。

完整设置、MCP 调用例子、对账、故障处理和权限说明见 [Minecraft 试玩指南](docs/minecraft-playtest.md)。

## 真机验收

在上述专用游戏服务运行时执行：

```bash
npm run minecraft -- verify
```

这条命令会修改测试展示台，并验证真实观察、预览、写入、重复请求、旧版本拒绝、响应丢失、bridge 重启对账及重启后的写入锁定。成功时输出各项验收结果，最终方块为蓝色。

普通 `npm test` 使用协议夹具，不会下载或启动游戏；它的通过不能替代这条真机验收，也不能替代游戏服务器强制崩溃/磁盘故障测试。

## 接给本地 MCP 客户端

构建后使用固定入口：

```text
node /你的仓库/dist/src/mcp/minecraft-stdio.js
```

默认锁住写入，只能观察/预览。用户在本地客户端配置中显式增加 `--allow-writes` 才启用本次进程的写权限。不要把此参数作为工具输入。Windows 还可使用现有 `npm run operator -- status|stop` 和带 generation 的本地 resume；Linux 首版没有独立 operator IPC，stop 后需本地重启再启用。

MCP 仍只有一个 `game_bridge_request` 工具，目录由 `bridge.describe` 返回。没有模型可调用的 resume、任意 RCON 命令、文件、shell 或地址参数。本次未配置云端 Tunnel/host 连接。

## 当前边界

- 一个专用本地世界、一个固定方块动作；每个 session 最多 16 次写动作，15 分钟有效。
- 动作前先用 SQLite FULL 提交 intent；游戏端维护单调操作序号和版本，写后确认 `save-all flush`、回执及实际方块。
- dispatch 后丢失确认返回 `OUTCOME_UNKNOWN` 与内部 `operationId`；新写入暂停，不会自动重做。
- 本地 `reconcile` 只核对/封住旧操作，不重复它的方块效果。结果落盘后重启，再人工启用写入。
- 每个测试世界最多保留 512 条操作，不静默删除。原始请求 ID、session 和凭据不进入操作库；库保留请求摘要、内部操作 ID、颜色、版本和状态。
- RCON 本身拥有服务端管理权限。边界来自可信 adapter 的固定命令与 loopback 配置，**不是**受限权限的 RCON 账号或 OS sandbox。仅用于新建专用测试世界。
- 不承诺断电时 Minecraft 多个保存文件的原子性，也不承诺 hostile same-user 防护、跨世界回档恢复或跨重启 exactly-once。历史/实际方块不一致时拒绝继续写。

## 开发与验证

```bash
npm ci
npm run check
npm test
npm run demo
npm audit
git diff --check
```

`npm test` 先构建一次。新增 SQLite 使用 Node 22 的内置实验性 API，没有新增运行时 npm 依赖。原 mock 产品的 Windows native 构建要求见 [历史 mock RC 说明](docs/mock-rc.md)。

`npm audit` 目前仍报告既有 Vitest 3.2.7 / @vitest/mocker 的两项中危问题（GHSA-82fw-gwwq-j7x9）；没有屏蔽审计，也未在游戏功能 PR 中混入测试框架大版本升级。

## 文档

- [试玩与恢复](docs/minecraft-playtest.md)
- [当前路线](docs/ROADMAP.md)
- [实现与验收交接](docs/HANDOFF.md)
- [架构](docs/architecture.md)
- [威胁模型](docs/threat-model.md)
- [原 mock RC 发布与支持矩阵](docs/support-matrix.md)
