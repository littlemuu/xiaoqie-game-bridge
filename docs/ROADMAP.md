# xiaoqie-game-bridge 路线图

> 状态：已决定
>
> 更新日期：2026-09-01
>
> 决策基线：`main@0baac6571903c1f587b288b85feb160299454470`
>
> 当前下一张工单：[Issue #19 — Adapter Contract v2、可信授权与运行健康基础](https://github.com/littlemuu/xiaoqie-game-bridge/issues/19)

## 1. 路线调整结论

当前项目已经建立了一套严谨的 mock-only 安全运行时：严格协议、session owner binding、capability 与 policy、幂等缓存、全局急停、本地 operator、持久审计、固定 mock worker、Windows Restricted Token + Job Object，以及可复现的 RC 发布证据。

这些能力构成了可保留的安全地基，但项目的施工顺序开始失衡：发布、审计和 Windows containment 已经达到较高成熟度，真实游戏需要反向验证的 adapter 领域契约、可信授权、状态一致性、动作结果对账和运行恢复仍然不足。

因此，从本路线开始，项目不再继续围绕 mock worker 叠加安全证明，而是转向验证一个更根本的问题：

> 这套通用 bridge 能否清楚、可控并可恢复地表达真实游戏能力。

本路线不推倒现有核心。default-deny、单一裁决路径、owner binding、幂等、operator 与模型请求面分离、固定能力白名单以及诚实的安全声明均继续保留。

## 2. 立即冻结的方向

在首个真实 adapter 的只读 vertical slice 完成之前，以下方向冻结，不再扩张：

- 不增加新的 release artifact、SBOM、provenance、attestation 或 workflow 证明层；
- 不继续强化 native launcher、Restricted Token、Job Object、父进程存活探针或测试型内核证据；
- 不重写 durable audit ledger，不增加签名、外部锚点、云日志、自动删除或日志浏览器；
- 不增加 HTTP、WebSocket、SSE、TCP、relay、tunnel、OAuth、pairing 或远程认证；
- 不构建通用插件市场、复杂策略语言、分布式 session 或持久身份系统；
- 不增加真实游戏写操作、存档写入或桌面自动化。

冻结并不表示删除。现有实现继续作为 RC 安全基线运行和回归，只是不再优先投入新的复杂度。

## 3. 必须长期保持的不变量

后续所有阶段都必须保持以下边界：

1. `GameBridge` 是 protocol、session、owner、policy、capability、idempotency、safety 与 audit 的唯一裁决路径。
2. adapter 不得自行授予 capability、扩大 action 集合、绕过 dry-run、幂等、revision 或 safety。
3. context/principal 由可信 transport 注入，不能由 request envelope、MCP tool 参数或游戏内容自报。
4. owner check 先于 session 状态、幂等缓存、capability、adapter、world 和 safety。
5. 模型可以触发 stop，但不能通过 MCP 或普通 bridge action 执行 resume。
6. 不提供 shell、通用进程、任意文件、网络、键鼠、桌面或开放世界能力。
7. transport timeout、worker exit、client disconnect 或进程终止不得被描述成真实动作已经取消、回滚或未执行。
8. 所有安全声明只覆盖实际证据，不把 RC、CI、Restricted Token、Job Object、checksum 或 hash chain 夸大为完整 sandbox 或供应链证明。

## 4. 分阶段路线

### 阶段 A：Adapter Contract v2、可信授权与运行健康

对应：[Issue #19](https://github.com/littlemuu/xiaoqie-game-bridge/issues/19)

本阶段仍只运行 mock adapter，目标是修正通用领域模型，而不是接入真实游戏。

必须完成：

- adapter 动作同时声明严格输入与输出 schema；
- 显式声明 read / preview / write、dry-run 精确度、required capabilities、结果大小、错误集合、revision 和并发语义；
- registry 在注册时验证、快照并冻结 manifest，运行中不能修改权限面；
- capability 从“调用方请求即可获得”升级为可信 grant profile 决定的交集；
- owner binding 与 grant 分层：owner 决定“谁”，grant 决定“能做什么”；
- observation/preview 返回 state revision，写操作可要求 expected revision；
- 同一游戏资源的写入默认串行，不能用“全局并发有上限”冒充状态安全；
- operator 可看到 closed-world 的 runtime / adapter / audit / safety 健康类别；
- 区分进入 adapter 前失败、adapter 明确拒绝、明确成功与 dispatch 后结果未知；
- `bridge.describe` 返回模型可理解、可序列化的 action catalog；
- package、MCP 与 protocol 版本收敛到单一来源。

阶段门禁：

- 全部现有安全回归、真实 stdio、真实 operator、demo、build、audit 和 release verification 无退化；
- 调用方不能自授全部 capability；
- stale revision 和不安全并发在 adapter 副作用前被阻止；
- adapter 非法输出和健康故障不会泄漏原始值；
- 仍未接触真实游戏或持久 operation store。

### 阶段 B：Operation journal、结果未知与 reconciliation

阶段 A 合并并复审后再开工单。

目标是解决真实副作用最危险的歧义：动作已经发生，但响应、进程或 transport 丢失。

必须完成：

- 用户 `requestId` 与内部不可伪造 `operationId` 分离；
- 在外部副作用前记录 durable intent；
- 成功或明确拒绝后记录 durable result；
- dispatch 后无法确认时返回稳定 `OUTCOME_UNKNOWN`，不得冒充失败或自动重试；
- adapter 可按 `operationId` 对账，或者明确声明不支持 reconciliation；
- 在对账完成前，不能用新 request ID 盲目重复同一效果；
- 安全关键 operation journal 与普通运行审计分层，普通审计故障不能吞掉已验证的只读结果；
- shutdown 使用明确的 accepting → quiescing → drained → closed 状态机。

阶段门禁：

- 受控 timeout、worker crash、client disconnect 和重启测试能够区分未 dispatch、明确结果与 outcome unknown；
- 不存在“动作已执行但返回普通 INTERNAL_ERROR 后被安全重试”的路径；
- journal 容量、恢复、损坏和清理策略严格有界。

### 阶段 C：首个真实 adapter 的只读 vertical slice

只有阶段 B 完成后，才允许接触真实游戏。本阶段仍禁止任何游戏写操作。

首个目标目前倾向 Minecraft，但必须根据实际受支持 API、mod/broker 方案与用户环境另行批准，路线图本身不构成接入授权。

只读 vertical slice 必须验证：

- 如何可靠识别一个游戏实例、世界或存档；
- observation 的窄视图、分页、最大结果、freshness 与 state revision；
- 游戏中的聊天、书本、牌子和其他文本如何标记为不可信输入；
- adapter 实际需要哪些文件、网络、mod API 和进程权限；
- 当前 Windows containment 是否适配真实 API，还是需要 adapter-specific broker、AppContainer、ACL 或其他边界；
- 真实只读错误、断连、游戏退出和版本不兼容如何映射到稳定健康状态；
- bridge 不读取整个世界、整盘文件、账号、凭据或无关存档。

阶段门禁：

- 只读 adapter 在明确范围内运行，不具备任何写 capability；
- 模型看到的 action catalog、schema、结果大小和不可信文本标记与真实返回一致；
- 退出游戏、adapter fault、audit fault 和 safety stop 的状态可由 operator 明确观察；
- 没有以通用文件、shell、键鼠或桌面自动化绕过游戏 API。

### 阶段 D：一个可恢复的最小写动作

只允许选择一个范围极窄、可以观察并对账的写动作，不一次接入整套游戏控制。

必须同时具备：

- 可信本地 grant profile 与明确资源 scope；
- expected revision；
- 同资源单写调度；
- durable intent/result；
- adapter reconciliation；
- 幂等或可证明的重复防护；
- 动作前后可观察证据；
- 必要时的备份、撤销或明确不可撤销声明；
- stop 后不再开始新动作；
- outcome unknown 时禁止自动重试；
- 单独的动作预算和失控循环熔断。

阶段门禁：

- crash、timeout、重复 request、stale revision 和 stop 竞态均有真实游戏回归证据；
- 不会因为 transport 返回失败而重复真实副作用；
- 写入范围不能通过模型参数扩大。

### 阶段 E：重新评估远程传输与更强 OS 边界

只有前四个阶段完成后，才重新讨论：

- authenticated remote MCP / paired relay；
- per-principal / per-action rate limit；
- credential lifecycle、revocation 与 origin binding；
- AppContainer、容器、VM、custom ACL 或 adapter-specific broker；
- 跨进程 session、distributed replay 或远程 operator ownership。

这不是默认下一步。若本地真实 adapter 已经满足需求，不为了“架构完整”强行增加远程复杂度。

## 5. 关键设计原则

### 5.1 capability 请求不等于授权

实际授权必须来自：

```text
请求能力
∩ 可信本地 profile
∩ adapter manifest
∩ 当前资源 scope
```

模型可以请求能力，但不能批准自己。session owner 也不等于权限来源。

### 5.2 有界并发不等于安全并发

全局最多四个写操作只能防止资源爆炸，不能保证同一世界、存档或对象的动作彼此兼容。真实 adapter 默认采用资源级单写，只有经过证据证明的动作才允许并行。

### 5.3 timeout 不等于动作未执行

只要调用已经 dispatch 到 adapter 或真实游戏，timeout、disconnect、worker exit 和 bridge restart 都可能留下已发生但未确认的效果。该状态必须显式表示为 outcome unknown，并通过 reconciliation 解决。

### 5.4 审计不等于 operation journal

审计用于记录安全决策和事件，不自动具备恢复动作结果所需的 intent、输入摘要、外部效果和对账状态。安全关键 operation journal 与普通运行审计应分层设计。

### 5.5 fail closed 必须配套可恢复性

拒绝危险动作是正确的，但产品不能只留下“手工去目录删除文件”的死路。后续需要 closed-world 的 operator health、stale runtime 恢复、journal seal/archive 和明确确认的数据重置流程；这些操作仍不得接受任意路径。

## 6. 当前已知阻塞

在真实写 adapter 前，以下问题必须关闭：

- capability 仍缺可信 grant；
- adapter contract 缺 output schema、revision、效果类型与错误命名空间；
- session 幂等只在活进程内成立；
- dispatch 后结果未知无法对账；
- safety latch 重启后恢复为 running；
- operator health 不能完整表达 adapter/audit/runtime 故障；
- durable audit 的关键安全事件与普通运行审计尚未分层；
- stale descriptor、audit full/corrupt 等状态缺少受支持的恢复路径；
- observation 缺分页、freshness、revision 和不可信游戏文本标记；
- 真实 adapter 的文件、网络、mod API 和存档权限尚未用实际需求验证。

## 7. 当前不做的事情

本路线不授权：

- 安装、启动或控制任何真实游戏；
- 登录 Microsoft、Steam、Nintendo 或其他账号；
- 读取、复制、修改或备份现有用户存档；
- 修改 MCP host 配置、系统 ACL、registry、firewall、service 或开机启动；
- 创建公网端点、tunnel、relay 或后台常驻服务；
- 发布 npm 包、正式 production release 或宣称当前 RC 已适用于真实游戏。

每一次扩大能力边界都必须有独立工单、明确验收证据和人工批准。