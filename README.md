# xiaoqie-game-bridge

`xiaoqie-game-bridge` 是一套 **offline-first、default-deny、本地优先** 的游戏能力桥接基础设施。长期目标是让云端主脑通过范围明确、随时可停、可审计的本地 adapter 操作游戏，而不是获得通用电脑控制权。

**当前版本：** `0.1.0-rc.1`  
**当前状态：** mock-only release candidate  
**当前产品路径：** Windows 非提权本地进程  
**当前真实游戏支持：** 无

> 当前 RC 只运行一个确定性的内存 mock world。它不会启动、检查或控制 Minecraft、Steam、Stardew Valley、SMAPI、launcher、账号、存档、桌面或其他真实应用。

## 当前定位

项目已经建立的安全基线包括：

- 严格、版本化、closed-world 的 bridge 请求与响应协议；
- memory-only、adapter-bound、caller-owned 的 session；
- capability、policy、dry-run、幂等缓存和有界并发写入；
- Adapter Contract v2：严格输入/输出 schema、效果类型、dry-run 语义、结果上限、错误集合与 revision 要求；
- 可信本地 grant profile、固定 tiny-world scope、session/action 预算与资源级单写调度；
- runtime / adapter / audit / safety 的 closed-world 健康状态与显式 `OUTCOME_UNKNOWN`；
- 模型可触发、但不能自行解除的全局 safety latch；
- 独立于 MCP 的本地 Windows named-pipe operator；
- 固定目录、追加式、有界、可恢复的本地安全审计账本；
- 固定 mock worker、严格 IPC、Windows Restricted Token + Job Object；
- client-spawned local stdio MCP，且只注册一个 `game_bridge_request` tool；
- 可复现的 `v0.1.0-rc.1` bundle、checksum、SBOM、manifest 与发布来源证据。

这些能力构成安全地基，但不代表项目已经适合真实游戏。当前路线已经调整：**冻结发布、审计和 Windows containment 的继续扩张，优先修正 adapter 领域契约、可信授权、状态一致性、动作结果对账和运行恢复。**

完整路线见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。本分支实现 [Issue #19：Adapter Contract v2、可信授权与运行健康基础](https://github.com/littlemuu/xiaoqie-game-bridge/issues/19)；合并复审通过后，下一阶段才是独立的 operation journal / reconciliation 工单。

## 当前不提供的能力

项目目前明确不提供：

- 任意 shell、PowerShell、通用进程执行或动态 executable/argv；
- 任意文件系统、整盘读取、通用网络、键盘、鼠标或桌面自动化；
- HTTP、WebSocket、SSE、TCP、relay、tunnel 或公网 endpoint；
- OAuth、pairing、远程认证、账号系统或持久 session；
- 真实游戏 API、mod、存档读写、launcher 控制或购买内容访问；
- hostile-code sandbox、完整文件/网络隔离或 hostile same-user 防护；
- 已开始动作的强制取消、回滚或跨进程 exactly-once 保证。

## 架构概览

```text
本地 MCP client（拥有并拉起一个 child process）
                     |
                     | stdin/stdout 上的本地 MCP
                     v
           stdio 边界：一个 tool
          64 KiB frame / 32 KiB envelope
                     |
                     | 固定 local context
                     v
                GameBridge core
 protocol | session | owner | policy | capability
 idempotency | safety | audit
                     |
                     | 严格、有界、版本化 adapter IPC
                     v
          ProcessMockAdapter
                     |
                     v
  固定 Win32 launcher -> Restricted Token + Job
                     |
                     v
           确定性内存 mock worker

独立的本地 operator CLI
                     |
                     | authenticated Windows named pipe
                     v
       同一个 bridge / safety latch / audit sink
```

核心仍然是唯一裁决点。transport 负责确立 caller context；core 负责 session owner、policy、capability、幂等、safety 和 audit；adapter 只执行已经被批准的窄动作。

## 五分钟验证

### 环境要求

- Node.js 22
- npm 10 或更新版本
- Windows 产品路径需要以下任一原生工具链：
  - MSVC Build Tools + Windows SDK；或
  - MinGW-w64 `g++`

仓库只提交窄 Win32 helper 的源码。构建时从源码编译，不提交或运行时下载 EXE/DLL。

### 验证命令

```bash
npm ci
npm run check
npm test
npm run demo
npm run build
npm audit
git diff --check
```

发布证据验证：

```bash
npm run release:workflow-policy
npm run release:reproducible
npm run release:build
npm run release:verify
```

最新的实际版本、测试总数、平台 skip、Windows 内核证据和本地验收结果见 [`docs/HANDOFF.md`](docs/HANDOFF.md)。

## 当前 mock world

mock adapter 只包含一个很小的内存世界：

- 观察玩家位置与附近方块；
- `move`；
- `place_block`；
- 方块仅允许 `stone`、`dirt`、`torch`；
- 坐标范围很小且固定；
- `dry-run` 返回预计变化但不修改状态；
- `commit` 只在 session、owner、capability、policy 和 safety 全部允许时执行；
- 相同 session 内重复使用相同 `requestId` 不会重复副作用。

mock world、session、幂等缓存和 safety latch 都不会跨产品进程重启保留。只有有界、脱敏的安全审计账本会持久存在。

## Session、owner 与 capability

session：

- 只保存在内存；
- 默认 TTL 15 分钟，最大 60 分钟；
- 默认最多保留 64 个 session；
- 绑定一个 adapter、一个不可变 owner key 和明确 capability 集合；
- terminal session 默认保留 5 分钟，由显式 `sweep()` 清理；
- 每个 session 默认最多保留 256 个 request 幂等条目；
- active session 和 in-flight request 不会被静默驱逐。

owner 来自可信 transport context，不来自请求参数。当前 local stdio 注入精确的 `{ transport: "local" }`；未来 remote seam 只是一份严格接口，生产环境尚无 remote credential verification。

capability 请求不等于授权。当前产品只使用可信代码中的 fixed mock profile，实际 grant 是“请求能力、可信 profile、注册时冻结的 adapter manifest 与 fixed tiny-world scope”的交集。session response 只返回实际批准能力、安全 scope 摘要和剩余有界预算，不返回 profile 内部结构或授权秘密。owner binding 回答“谁在使用 session”，grant 回答“该主体能做什么”，两者不互相替代。

## 幂等与并发

- 相同 session、相同 `requestId`、相同请求内容会复用原结果或等待同一个 in-flight promise；
- 相同 ID、不同内容返回 `REQUEST_ID_REUSED`；
- 幂等证据只存在于当前产品进程；
- 全局默认最多同时有 4 个 commit write；
- MCP 默认最多同时有 8 个 handler；
- adapter IPC 默认最多有 8 个 pending call；
- 达到容量时在 adapter 副作用前拒绝，不建立无界等待队列。

这些限制只能证明资源有界，不能单独证明状态安全。Adapter Contract v2 另外要求同一 adapter/scope/resource 的写入默认单写；observation 必须显式声明 `parallel`、`serial` 或 `resource-serial`，纯只读 adapter 可以声明零个 action，也不需要 revision provider。`game.act` 的 effect × mode 矩阵是封闭的：write action 可按声明接受 commit 或 dry-run，read/preview action 只能使用 dry-run，任何 non-write commit 都在 adapter dispatch、写调度和预算预留前固定拒绝。mock observation 和 preview 返回 `stateRevision`，声明需要 revision 的 commit 必须携带 `expectedRevision`。core 在派发前发现的 stale/future revision、预算耗尽、stop 和并发占用均不扣预算；已派发到 worker 的明确拒绝（包括 worker 侧 revision conflict）扣一次，幂等重放不重复扣减。成功 commit 只递增一次。

## Safety latch 与本地 operator

普通 bridge/MCP action 可以执行 `safety.stop`，但协议中不存在 `safety.resume`。

产品运行时启动后，可在另一个本地终端使用：

```text
npm run operator -- status
npm run operator -- stop
npm run operator -- resume --generation 1
```

operator：

- 使用每次启动随机生成的 Windows named pipe 和 32 字节 token；
- 与 MCP 共用同一个 bridge、safety latch 和 audit sink；
- 不接受 host、port、URL、path、executable 或环境覆盖；
- stop 独立于 session、request cache、MCP handler 和 adapter pending capacity；
- resume 必须携带当前 stop generation；
- 有 in-flight write、generation 不匹配、deadline、disconnect、后发 stop 或 audit 未确认时均拒绝恢复；
- status 当前只暴露安全状态和非敏感计数，不读取审计内容。
- status 同时返回并由 CLI 显示固定的 runtime / adapter / audit / safety 健康类别及非敏感计数。

现有限制：safety latch 状态不持久化，产品重启后会创建新的 running latch。真实 adapter 启动前必须决定“启动默认 stopped”或持久安全状态的恢复语义。

## 本地 MCP 契约

构建后，本地 MCP client 可拉起：

```text
node dist/src/mcp/stdio-server.js
```

也可以运行：

```bash
npm run mcp:stdio
```

MCP surface：

- 恰好一个 tool：`game_bridge_request`；
- 不注册 resource、prompt、sampling、operator 或其他 tool；
- tool 输入直接复用 bridge request envelope；
- MCP JSON-RPC ID 与 bridge `requestId` 是两层不同标识；
- wrapper 不替换 request ID、不自动重试；
- stdout 只承载 MCP 协议，固定脱敏诊断写入 stderr；
- bridge 输出会再次经过 schema、请求身份和脱敏验证；
- client disconnect 不被描述成已经取消或回滚进入 core/worker 的动作。

MCP 仍只使用一个通用 tool；`bridge.describe` 现在返回纯 JSON action catalog，包含输入/输出 JSON Schema、read/preview/write、dry-run 精确度、required capabilities、revision、结果上限、资源调度与 adapter error namespace，不返回 Zod 实例或函数。注册使用 Zod node/check/options 正向白名单，只接受可转成 JSON Schema 的声明式子集；refinement、transform、codec、overwrite/trim、coerce、用户 `when`、自定义 JSON Schema emitter、非有限或不能无损 JSON 表示的数字，以及任何未知定义字段均拒绝。转换使用每次注册独有的空 metadata registry，源 schema 的 global metadata 不能改写契约快照；活动 validator 由不可变 JSON 快照重建并隐藏在闭包中。MCP server version 从 `package.json` 单一来源读取，协议版本只使用 `PROTOCOL_VERSION`。

## 持久审计账本

产品只在固定的当前用户应用目录中保存 bridge/operator 的有限安全事件。它不是游戏存档，也不保存：

- game state、观察结果或 adapter 输入/输出；
- chat、屏幕、账号、存档或凭据；
- 原始 request/session ID、principal、owner key；
- endpoint、named pipe、PID、用户名、路径、stack 或 raw payload。

当前硬上限：

- 单记录 4 KiB；
- 最多 8 个 pending write；
- 单 segment 64 KiB；
- 最多 8 个 segment；
- 最多 2,048 个 confirmation；
- 最多 2,048 个 checkpoint；
- shutdown drain deadline 500 ms。

账本使用 canonical frame、单调 sequence、SHA-256 链、data sync、confirmation 和独立 checkpoint 检测普通撕裂写、截断、乱序和意外损坏。它没有受保护密钥或外部锚点，不能抵御 hostile same-user、管理员或离线磁盘重写。

达到硬容量后不会静默删除历史。新的普通 commit 和 resume 会 fail closed；emergency stop 仍先同步关闸，再尝试写 audit。

## Windows worker containment

产品只启动固定的源码构建 Win32 launcher；launcher 再用固定 `process.execPath`、固定 built worker、固定 argv/cwd/minimal environment 启动 mock worker。

已建立的 Windows 约束包括：

- Restricted Token；
- suspended create → Job assignment/query → attestation → resume；
- kill-on-close；
- active-process limit 1；
- process memory 256 MiB；
- job memory 192 MiB；
- CPU hard cap 20%；
- no breakaway；
- 精确 handle allowlist；
- 独立 parent-liveness pipe；
- containment 失败时无 unrestricted `spawn()` fallback。

这些约束限制权限、进程树、资源和生命周期，但不是文件系统、registry 或网络 sandbox。真实 adapter 仍需根据实际游戏 API 单独决定 AppContainer、ACL、broker、容器或其他权限边界。

## 发布与支持矩阵

`package.json` 保持 `private: true`，本项目不发布 npm package。

`v0.1.0-rc.1` 的发布链可生成：

- 规范化源码构建 bundle；
- SHA-256 checksum；
- CycloneDX SBOM；
- release manifest；
- unsigned local provenance；
- 受保护 annotated tag 流程中的 GitHub artifact attestation。

这些证据用于减少 source/artifact 歧义，不证明 runner、编译器、依赖或完整供应链可信，也不证明真实游戏安全。

平台范围：

- Ubuntu：运行平台中立套件；Windows 产品 child/operator 用例明确 skip；
- GitHub-hosted Windows：runner 为 elevated，只验证产品正确拒绝 elevated host，并编译 MSVC/UCRT helper；
- 完整 happy path：需要真实非提权 Windows 主机；当前证据来自本地验收，尚无合适的 dedicated hosted runner。

详见：

- [`docs/support-matrix.md`](docs/support-matrix.md)
- [`docs/release.md`](docs/release.md)
- [`docs/release-notes-v0.1.0-rc.1.md`](docs/release-notes-v0.1.0-rc.1.md)

## 新路线

阶段 A 已由 Issue #19 本分支实现。后续仍严格按以下顺序推进：

1. **operation journal、durable `operationId` 与 reconciliation**；
2. **首个真实 adapter 的只读 vertical slice**；
3. **一个具备 revision、journal、对账和恢复证据的最小写动作**；
4. **完成上述证据后，再评估远程传输和更强 OS 权限边界**。

在只读真实 adapter 完成前，release、ledger、containment 和 remote transport 均保持冻结。

完整阶段门禁、设计原则和当前阻塞见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 当前关键限制

- session/idempotency 只在活进程内成立；
- dispatch 后 timeout/worker exit 现在会保守返回 `OUTCOME_UNKNOWN`，但尚无 durable operation journal、内部 `operationId` 或 reconciliation；
- safety latch 不跨重启持久；
- operator 能表达固定健康类别，但尚无 stale runtime、audit full/corrupt 或 adapter fault 的受支持恢复命令；
- audit 与未来 operation journal 尚未分层；
- stale descriptor、audit full/corrupt 尚缺受支持的 operator 恢复流程；
- observation 尚缺真实游戏所需的分页、freshness、revision 和不可信文本标记；
- Restricted Token + Job Object 尚未由任何真实 adapter 权限需求验证。

## 文档索引

- [`docs/ROADMAP.md`](docs/ROADMAP.md)：新的项目路线、阶段门禁与冻结边界
- [`docs/architecture.md`](docs/architecture.md)：当前架构与责任边界
- [`docs/threat-model.md`](docs/threat-model.md)：威胁、控制与残余风险
- [`docs/HANDOFF.md`](docs/HANDOFF.md)：当前实现、实际验收证据与已知限制
- [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md)：仍需未来工单决定的问题
- [`docs/release.md`](docs/release.md)：RC 构建、复现、发布与回滚
- [`docs/support-matrix.md`](docs/support-matrix.md)：平台支持与证据范围

任何真实游戏、远程 transport、主机配置、OS 权限扩大或持久动作状态，都必须通过独立工单和人工批准。
