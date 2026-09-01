# 开放问题

> 更新日期：2026-09-01  
> 路线依据：[`docs/ROADMAP.md`](ROADMAP.md)  
> 当前实施工单：[Issue #19](https://github.com/littlemuu/xiaoqie-game-bridge/issues/19)；合并复审后才为阶段 B 建立独立工单

本文件只保留真正需要未来工单或人工批准的问题。已经由路线复审决定的事项不再反复列为开放选择。

## 已经决定，不再开放讨论的事项

1. 当前 `v0.1.0-rc.1` 继续保持 mock-only、offline-first、default-deny。
2. default-deny、单一 `GameBridge` 裁决路径、session owner binding、幂等、独立 operator、durable audit、固定 mock worker 和 Windows containment 均保留。
3. 发布链、durable ledger 和 Windows containment 暂时冻结，不继续增加新的证明层或安全机制。
4. Issue #19 已选择并实现 Adapter Contract v2、可信 grant、state revision、资源级写入串行化和运行健康；下一阶段不是 remote relay、Minecraft 写入、更多 provenance 或更强 native sandbox，而是 operation journal 与 reconciliation。
5. capability 请求不等于授权；真实 grant 必须来自可信本地 profile、adapter manifest 与资源 scope 的交集。
6. 有界并发不等于状态安全；同一真实游戏资源的写操作默认串行。
7. timeout、worker exit、client disconnect 或进程终止不等于动作未执行，也不授权自动重试。
8. 真实 adapter 必须先经过只读 vertical slice，再批准一个可恢复的最小写动作。
9. 在真实只读 adapter 和 operation reconciliation 完成前，不重新评估远程 transport。

## 阶段 A 已采用的实现选择

以下事项已在 Issue #19 分支中采用最小、保守、可替换的实现，不再作为开放问题：

- Adapter Contract v2 的字段组织与 TypeScript 命名；
- manifest 注册时的验证、快照和冻结方式；
- Zod input/output schema 到 closed-world JSON Schema 的最小转换方式；
- 可信 mock grant profile 的具体代码结构；
- commit dispatch attempt 的 session/per-action 有界预算；dry-run、dispatch 前拒绝和重放不扣减，adapter 明确拒绝与 outcome unknown 扣减一次；
- mock state revision 与同资源单写 permit 的最小实现；
- mock observation 的并行只读语义与 preview 不取得 write permit 的最小调度规则；
- runtime/adapter/audit/safety 健康枚举的具体类型；
- package、MCP、protocol 版本单一来源的最小实现；
- 重复 stable/canonical JSON helper 的收敛方式。

这些选择仍需完整验收和 Draft PR 复审，但不扩大能力边界，也不授权真实 adapter、持久 operation store 或远程 transport。

## 阶段 B：Operation journal 与 reconciliation

阶段 A 合并并复审后，需要单独决定并实现：

1. durable operation journal 使用追加文件、SQLite、其他本地事务存储，还是 adapter-specific broker；选择必须基于真实 crash/recovery 需求，而不是为了通用化。
2. journal 记录哪些最小字段，既足以恢复 intent/result/reconciliation，又不持久化原始凭据、无关游戏内容或宽泛 raw payload。
3. `operationId` 的生成、生命周期、容量、retention 和 seal/archive 规则。
4. adapter 明确成功、明确拒绝、dispatch 前失败和 `OUTCOME_UNKNOWN` 的统一结果模型。
5. `reconcile(operationId)` 是每个真实写 adapter 的强制能力，还是允许某些动作声明不可对账并因此禁止自动化写入。
6. journal 满、损坏、crash recovery 和 acknowledged reset 的 operator 流程。
7. 普通运行审计与安全关键 operation journal 的分层：哪些事件必须同步确认，哪些只读事件允许在审计 degraded 时继续返回安全结果。
8. shutdown 的 accepting → quiescing → drained → closed 状态机及每一阶段可用的 operator 命令。

在这些问题解决前，不允许真实游戏写操作。

## 阶段 C：首个真实只读 adapter

首个真实 adapter 目前倾向 Minecraft，但路线图本身不构成接入授权。开始前仍需确认：

1. 采用哪个受支持 API、mod、broker 或插件接口；不得以键鼠、屏幕识别、通用文件扫描或 launcher 注入替代正式 API。
2. 支持哪些 Minecraft 版本、loader、单人/服务器模式和游戏实例发现方式。
3. 如何只识别用户明确批准的实例、世界或存档，而不扫描或读取其他用户文件。
4. observation 的最小视图、分页、结果大小、freshness、state revision 和 world identity。
5. 聊天、书本、牌子、命令方块文本及其他游戏内容如何标记为不可信模型输入。
6. read-only adapter 实际需要的文件、网络、进程、mod API 和 IPC 权限。
7. 当前 Restricted Token + Job Object 是否兼容真实 API；若不兼容，采用 AppContainer、custom ACL、container/VM、adapter-specific broker 或其他机制中的哪一种。
8. 游戏退出、版本不匹配、mod 未加载、world 切换、连接断开和 partial observation 如何映射到健康状态。
9. 是否需要本地用户在每次启动时重新选择实例，还是可以保存一个不含 bearer secret 的最小批准绑定。

任何需要账号登录、购买内容、现有存档读取或主机配置修改的步骤都必须另行批准。

## 阶段 D：首个真实写动作

在只读 vertical slice 完成后，仍需逐项决定：

1. 首个写动作是什么，以及为什么它比移动、批量建造、物品交易、聊天或存档写入更容易对账和恢复。
2. 动作对应的 resource scope、expected revision、单写 concurrency key 和 action budget。
3. 动作能否通过游戏 API 原生幂等；若不能，如何避免重复效果。
4. crash、timeout 或 disconnect 后如何观察并 reconcile 结果。
5. 是否有安全的 undo、备份或补偿动作；若不可撤销，如何要求额外本地确认。
6. safety stop 对尚未 dispatch、已 dispatch、正在等待结果和 outcome unknown 动作分别具有什么准确语义。
7. 是否需要 cooperative cancellation；若游戏 API 不支持，如何暴露 in-flight 和禁止误报“已取消”。
8. 失控循环的 per-session、per-action、per-resource 预算与熔断阈值。
9. 真实写动作的审计、journal、备份与用户可见回执保留多久。

## 本地 operator 与恢复

以下问题仍需独立工单：

1. safety latch 是否在真实 adapter 启动时默认 stopped，还是持久化并恢复上一次安全状态。
2. stale operator descriptor 的 closed-world 恢复流程；当前异常 kill 后重启会 fail closed，但没有受支持的用户操作命令。
3. operator descriptor 是否需要显式 Windows DACL、restricted-token broker 或 OS-owned rendezvous；当前继承 ACL 不是 hostile same-user 隔离证明。
4. 当前 operator `status` 已固定显示 runtime/adapter/audit/safety 类别与非敏感计数；阶段 B 是否需要 journal 状态或 drained 计数，仍必须保持 closed-world，不能变成日志浏览器或任意文件管理接口。
5. audit full/corrupt、journal full/corrupt、adapter fault 和 runtime fault 的 seal、archive、quarantine、acknowledged reset 流程。
6. 恢复操作如何确保只处理固定应用对象，不接受任意 path，也不删除无法重新识别的文件。

## 审计与长期证据

1. 当前 audit ledger 是否需要受支持的 retention、seal、archive 和删除策略。
2. 若允许删除历史，如何要求明确本地确认，并在删除前保存可验证的摘要或导出证据。
3. 是否需要 protected signing key 或 external anchor。当前 SHA-256 链只检测普通损坏，不抵御 hostile same-user、管理员或离线重写。
4. 是否继续保留每记录 confirmation + checkpoint 的小文件结构，还是在 operation journal 设计时改为更简单的事务存储或周期 checkpoint。
5. 只读运行审计失败时，哪些请求仍可返回；哪些安全关键事件必须 fail closed。

在没有真实 operation 需求前，不为了密码学完整性继续扩张 ledger。

## 远程 transport 与身份

只有本地真实 adapter 路线完成后，才重新讨论：

1. paired relay、authenticated remote MCP 或其他 transport 是否真的有必要。
2. credential verification、subject lifecycle、revocation、origin binding、TLS 和设备配对方式。
3. per-principal、per-action、per-resource rate limit 与 quota。
4. 跨进程 session、owner binding、distributed idempotency 和 replay store。
5. remote operator ownership：远程主体是否永远不得 resume，还是存在单独的人工批准通道。
6. 网络故障、重连和自动重试如何保持 operation ID，而不重复真实副作用。
7. 是否需要后台 service；默认答案仍为否，除非有明确用户价值和独立安装/卸载设计。

## 发布、平台与项目治理

1. 仓库规则能否保护 annotated RC tag，并允许官方 GitHub artifact attestation action。release workflow 当前对此 fail closed。
2. 完整、可长期保存的真实非提权 Windows RC 证据应放在哪里；GitHub-hosted Windows 为 elevated，不能替代 happy path。
3. 后续公开分发采用什么 license。当前 RC 不自行添加 maintainer 尚未选择的许可证授权。
4. 何时把 PR 工作流中的完整 reproducible release 验证降为 tag/定期任务，以减少真实 adapter 重构的 CI 负担；在路线冻结期不急于修改。
5. 首个真实 adapter 是否需要独立版本、兼容矩阵和 adapter-specific release artifact，而不是把所有平台能力塞入同一个 core bundle。

## 当前明确不授权的范围

开放问题不等于授权。当前仍禁止：

- 安装、启动或控制任何真实游戏；
- 登录账号、接受 EULA、购买内容或读取现有存档；
- 修改 MCP host、launcher、registry、ACL、firewall、service、driver、计划任务或开机启动；
- 创建公网 endpoint、tunnel、relay 或后台常驻服务；
- 引入 shell、通用进程、任意文件、通用网络、键鼠或桌面自动化能力；
- 自动删除审计证据、自动重试 outcome unknown 动作或静默扩大 capability；
- 把当前 RC、Windows containment、checksum、SBOM 或 CI 绿灯描述成真实游戏安全证明。
