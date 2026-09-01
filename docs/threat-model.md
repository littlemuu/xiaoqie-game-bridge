# Threat model

## Release-chain claims and non-claims

Pinned action commits, a clean double build, checksums, an SBOM and GitHub
attestation reduce accidental source/artifact ambiguity. The release workflow
fails before publishing when its protected tag, evidence files, digests,
attestation or upload verification is absent. Pull requests and ordinary pushes
retain only read permissions and cannot enter that job.

Tag builds separate untrusted dependency/project execution from release
credentials. The read-only build job uploads the verified allowlist; only its
dependent publish job receives write/OIDC permissions, downloads that exact
artifact and runs the narrow built-in-only verifier before attestation/upload.
All YAML `uses:` keys are enumerated and must match a closed unquoted local
action or a full lowercase 40-hex external pin with a readable version comment.

These controls do not prove a trustworthy runner, dependency safety, absence of
compiler compromise, complete supply-chain security or runtime behavior. The
unsigned local provenance statement is not presented as platform attestation.
GitHub-hosted Windows remains elevated-only evidence, and Restricted Token plus
Job containment still does not block all current-user-readable files or network
access. Nothing here authorizes untrusted code or a real game.

## Assets and trust boundaries

The protected assets are the user's future game process and saves, local
credentials, the integrity of allowed game actions, and the ability to stop the
bridge. Cloud reasoning and future transports are not implicitly trusted to
perform arbitrary local work. The local bridge core remains the enforcement
boundary, and adapters are treated as separately reviewable capability modules.

The current implementation touches none of those real assets. Its only mutable
game asset is an in-memory mock world held by a fixed adapter worker. The MCP
stdio child is a local protocol boundary. The nested adapter child additionally
uses a real Windows Restricted Token and dedicated Job Object, but this is not
proof of remote identity or a complete OS sandbox.

## Threats and current controls

### Prompt injection requests broader authority

A model, game text, or untrusted document could instruct a future transport to
run a command or call an undeclared action. The envelope is strict, bridge
actions are enumerated, policy is default-deny, and every adapter action has a
strict schema and explicit capability. There is no generic command, process,
filesystem, network, keyboard, or mouse primitive to invoke.

The MCP tool accepts the existing strict bridge envelope directly. Context,
principal, and transport identity are not tool fields: trusted server code
injects a frozen local context. A caller that adds undeclared envelope fields is
rejected by the SDK schema before `GameBridge.handle`; action-specific schemas
still reject undeclared fields inside `params`.

capability 请求本身不产生授权。session grant 必须同时落在调用方请求、可信
mock profile、注册时快照的 adapter manifest 与 fixed tiny-world scope 内；
owner digest/session ID 都不能扩大 grant。manifest 的 action、schema、required
capabilities 和 metadata 在注册后不能通过替换原对象来扩大权限面。

### Token disclosure and replay

Sessions are memory-only. Audit events store truncated SHA-256 tags instead of
raw request/session identifiers. Attacker-controlled unknown actions and
unregistered adapter IDs are also reduced to fixed categories plus hashed tags.
The product ledger drops generic event metadata entirely; it cannot persist an
undeclared path, game-state/input/output field, or blocklist-evasion value.
The in-memory injectable sink still recursively redacts credential-shaped keys.
Future
transports must keep bearer credentials outside request params, authenticate
before opening a session, encrypt transport traffic, and bound token lifetime.

Caller context is an out-of-band trusted transport input, never an envelope or
MCP field. Its own data-property descriptor values are captured once, then that
captured graph is strict-validated, copied, and deeply frozen before any
`await`. Validation never rereads the caller object, so stateful Proxy values
cannot create a check/copy gap or escape as a raw exception. A session stores
only a domain-separated, length-prefixed full
SHA-256 owner key. Remote ownership binds transport, authentication method, and
subject; local ownership uses a fixed process-local domain. Raw principal,
owner key, and full digest are never serialized. Audit correlation uses a
separately domain-separated 12-hex HMAC tag with a process-memory-only random
32-byte key. The key is copied on bridge construction and never persisted or
serialized, preventing offline enumeration of low-entropy principals from an
observed tag.

Replay within a session is handled by a request-ID cache. The first request
installs an in-flight promise before adapter completion; concurrent or later
identical replays await or return the same response without executing again.
Reusing the ID for different content returns `REQUEST_ID_REUSED`.

Owner comparison occurs before session state, cache lookup or wait, cache
capacity bypass, capability, adapter, world, and safety checks. Therefore a
different or untrusted caller cannot learn a completed response, join an
in-flight promise, stop safety, or exploit the full-cache close bypass. All
such existing-session attempts return fixed `AUTHORIZATION_DENIED` without
revealing the original owner.

### Duplicate or ambiguous actions

Per-session idempotency covers allowed and denied session-scoped requests. A
request fingerprint uses deterministic key ordering. Future distributed
transports must preserve the request ID and must not generate a fresh ID when
automatically retrying a write.

Adapter Contract v2 进一步区分 dispatch 前拒绝、adapter 明确拒绝、明确成功与
dispatch 后 `OUTCOME_UNKNOWN`。同一个 session/request ID 会缓存并重放同一
分类，不会自动生成新 ID 再试。当前仍没有 durable operation journal 或
reconciliation，因此 `OUTCOME_UNKNOWN` 会把 runtime commit health 置为
`faulted`；该保守停止不能被描述成动作未发生或已回滚。

MCP's JSON-RPC request ID is transport bookkeeping and is unrelated to the
bridge `requestId` inside tool arguments. The stdio wrapper does not synthesize,
replace, or automatically retry bridge IDs. A logical-size or handler-capacity
rejection happens before the core, so it creates no idempotency evidence; the
same bridge ID may be tried later when transport capacity is available.

### Runaway loops and excessive call rate

The core has finite session count, per-session request history, and concurrent
commit-write limits. Session open sweeps eligible terminal state before a
stable capacity refusal. Request capacity never evicts in-flight or completed
commit evidence; new requests are refused before adapter execution.

Adapter Contract v2 不从这些容量上限推导安全并发。每个 observation 显式声明
`parallel`、`serial` 或 `resource-serial`；后两者使用无等待队列 permit。
preview action 不取得 write permit；read/preview 都不能修改 world。纯只读 adapter
可声明零个 action 且无需 revision provider。commit write 在现有全局 safety gate
内取得 adapter/scope/resource 单写 permit。未来真实 adapter 必须用实际证据声明
自己的读取与写入语义，不能隐式继承 mock 的并发结论。

The stdio transport has an explicit 64 KiB read-buffer ceiling. The tool handler
independently measures deterministic UTF-8 envelope bytes and refuses more than
32 KiB. A synchronous gate admits at most eight concurrent handlers by default;
full capacity rejects immediately before bridge/adapter execution and creates no
unbounded queue. Permits release in `finally`. Future remote work still needs
per-principal and per-action rate limits.

session 还具有总 commit-attempt 与 per-action 预算。同资源写入使用无等待队列
的单写 permit；全局最多四个 write 只负责资源上限，不再被当作状态安全证明。
预算只在 revision、health、safety 与资源 permit 全部通过、即将 dispatch 前
原子预留；adapter 明确报告 `not-dispatched` 时回滚。dry-run、dispatch 前拒绝和
幂等重放不扣减，worker 已接收后的明确拒绝或不确定结果只扣一次。

### Protocol output or diagnostics leak attacker data

Every core result is validated by `responseEnvelopeSchema`, sanitized, and
serialized deterministically. Invalid output, thrown errors, and mismatched
request identity become a fixed `INTERNAL_ERROR`; raw results, stack traces, and
exceptions are not written to MCP. Stdout carries MCP only. Transport failures
write a fixed message to stderr without embedding the received frame or error.

observation 和 action 返回值在进入 `BridgeResponse` 前还必须通过注册快照中的
output schema 与固定 UTF-8 字节上限。schema 不匹配、不可 JSON 序列化或过大
只返回固定 `ADAPTER_OUTPUT_INVALID` / `ADAPTER_RESULT_TOO_LARGE`；原值、
sentinel 与 stack 不进入 response、MCP text、stderr 或 audit。

### Audit loss, corruption, or false durability

The product sink is a fixed-directory, append-only, bounded local ledger rather
than process memory. Each strict versioned frame carries a monotonic sequence,
previous-record digest, and current digest over canonical bytes. Writes are
serialized and do not acknowledge until the complete append/data sync plus
exclusive strict per-sequence confirmation and matching checkpoint file syncs
resolve. Startup verifies identical contiguous evidence sets and the whole
owned frame chain before operator/MCP commit admission. A partial or complete
tail with neither evidence file is provably unacknowledged and is retained/
continued only through one bounded recovery record in a new segment. Missing
or mismatched evidence, a missing/shortened committed frame, checksum/schema/
order failures, unexpected objects, and object-identity changes fail startup
closed without repair.

Limits are 4 KiB per record, 8 outstanding writes, 64 KiB per segment, 8
segments, 2,048 confirmations, 2,048 checkpoints, and 500 ms for ledger shutdown drain. A commit
reservation holds a worst-case record's physical bytes before side effects,
including rotation fragmentation. There is no eviction, deletion,
retry loop, retention timer, upload, database, or remote log service. At the
hard segment limit, ordinary commits and resume refuse before new side effects.
Stop is intentionally asymmetric: it closes the latch synchronously before
attempting audit, so a full/rejected/corrupt sink can degrade the command result
but cannot reopen the gate. A resume authorization must be sync-acknowledged
while its generation/deadline transaction is still live.

The ledger is not a game save and has no fields for requests, adapter
input/output, observations, world/player state, chat, accounts, screens, or
save data. Identifier correlation is limited to existing safe tags. No MCP or
operator command reads records or selects a path.

SHA-256 here detects accidental damage and inconsistent ordering inside a
trusted same-user boundary. There is no protected signing key or external
anchor. Hostile same-user code, an administrator, or an offline disk editor can
rewrite both data and digests or remove a complete tail; this design is not
tamper-proof. Likewise, Node/OS `sync()` acknowledgement does not bypass
hardware caches or guarantee every physical power-loss model.

When shutdown reaches its deadline, native segment/evidence write and sync
continuations reject and no later frame, confirmation, or checkpoint write can
run. Node cannot forcibly cancel an OS file operation already pending; the ledger stops awaiting/reusing that handle.
When the operation settles, its only continuation closes the handle, with
the abort signal—not a later closed-state assignment—owning that cleanup.
Process exit is the fallback; bytes lacking both evidence files remain
unacknowledged on restart.

### Adapter exceeds its authority

Sessions bind to exactly one adapter. Policy uses only that adapter's registered
actions and schemas. Capability names are checked both when the session opens
and when the action executes. A real adapter still requires code review and
adapter-specific sandboxing because TypeScript interfaces alone cannot contain
malicious implementation code.

每个 action 同时声明 effect kind、dry-run 语义、required capability 集合、
result limit、资源并发键、adapter error allowlist、revision 要求和未来
reconciliation 能力。`bridge.describe` 只输出可序列化 JSON Schema 与这些
固定字段，不暴露 Zod 实例或函数。adapter-specific 错误只能作为固定
`ADAPTER_REJECTED` 下的 allowlisted code 出现，不能扩张 core error enum 或
回显异常文本。

注册按 Zod node/check/option 正向白名单只接受能无损转成 JSON Schema 的声明式
子集。注册先以 descriptor 捕获有界、own-data-only 的不可变 AST；hole、accessor、
symbol/extra key、Proxy 异常、自定义 `_zod.toJSONSchema` / `_zod.processJSONSchema`、
非有限/有损 JSON number 与任何未识别定义均被拒绝。Zod 内建 object lazy-shape
getter 按锁定实现身份读取恰好一次。可信 schema 从 AST 重建后才使用独有空
metadata registry 发射；活动 validator 再从深冻结 JSON 快照的隔离副本重建并
隐藏，因此源 definition graph、metadata、emitter 或后续修改不能改变验证逻辑。

Capability grant 虽来自受信 provider，仍作为运行时边界严格捕获、校验、复制：
对象和 scope 无额外字段或 accessor，TTL 是受请求/全局上限约束的正 safe
integer，capability 是请求与 manifest 的去重子集，scope kind 属于 adapter
namespace，budget key 只引用 manifest write action。非法 grant 在 session 插入和
audit reservation 之前固定拒绝，因此 `NaN` expiry 不能形成不可回收 session。
异步 grant 返回后还会立即重检 runtime/adapter/audit health；quiescing 或 faulted
转换不能在 provider 等待窗口后提交 session。

`game.act` 的 effect × mode 是闭合集合：read/preview action 只允许 dry-run，commit
仅属于 write action；non-write 同时必须声明 `writeConcurrency: none`，不能在 catalog
中声称运行时未执行的 `resource-serial`。non-write commit 在 adapter dispatch 前固定拒绝，因而不能靠
`mode === "commit"` 绕过 write health、safety latch、resource scheduler、revision
admission 或动作预算。

manifest 的 required capability 与 adapter error code 数组使用 descriptor-based
dense capture；hole、index accessor、symbol/extra key 在任何元素读取前固定拒绝。

The parent still owns identity, session binding, capabilities, action schemas,
policy, idempotency, safety, and audit. Static metadata must exactly match the
worker handshake. Caller/session/request identity and secrets never enter IPC.
Fixed native-launcher/executable/argv/cwd plus a minimal supplied environment
prevent requests from turning this into a generic launcher; a credential-shaped
parent sentinel is regression-tested as absent from a real built child. The
product runtime does not publish commit surfaces until trusted containment
attestation and the exact worker handshake both succeed.

### Worker protocol or lifecycle failure

IPC has strict versioned messages and bounded frames, payloads, pending calls,
and deadlines. Unknown fields/types, wrong or duplicate IDs, timeout, EOF,
crash, non-zero exit, and hostile stdout fail closed. Stderr is discarded, and
worker/path/stack/raw output never reaches bridge responses or audit. Pending
promises settle once with timers/capacity released; normal close waits for
acknowledged zero exit. There is no unbounded queue.

commit 已经 dispatch 后的 timeout、worker exit、非法 result 或无法确认的
内部异常均保守映射为 `OUTCOME_UNKNOWN`；只有 adapter 在 strict IPC 中明确
返回 allowlisted 拒绝，才是 `ADAPTER_REJECTED`。client disconnect 不触发自动
重试，也不声称取消已经进入 worker 的动作。

The native helper now verifies a Restricted Token and dedicated Job before
resuming worker code. Kernel limits deny a second process, cap process/job
memory and CPU, disallow breakaway, and kill members when the Job handle closes.
The helper suppresses worker stderr and exposes only strict attestation/fault
categories. Token/Job/create/assign/attest/resume failures all close handles and
fail before a worker handshake; the pre-assignment failure path explicitly
terminates the still-suspended process.

Parent lifetime is bound to a dedicated inherited pipe endpoint rather than a
process-table scan or PID lookup. The helper validates that closed-world pipe
before attestation/resume, never passes it to the worker, and closes the Job when
the endpoint breaks; PID reuse therefore cannot redirect the lifetime wait to an
unrelated process. A real abnormal-exit regression proves both the launcher and
the contained worker terminate; worker termination is confirmed by the
launcher's exact process handle rather than a PID lookup. The process-limit
regression likewise uses an exact suspended candidate handle: Job assignment
must return the quota failure,
the candidate's termination is confirmed, and the Job is re-queried to contain
only the original worker before JavaScript resumes. The real worker then makes
the forbidden child attempt; after its denial settles, trusted post-attempt
accounting must show zero active/listed Job members.

This does not make a malicious worker safe. Restricting SIDs intentionally
preserve the source user and enabled non-privileged groups needed by the fixed
Node and repository ACLs. There is no AppContainer, VM, container, custom file
or registry ACL, network policy, or same-user adversary defense. A real adapter
still requires separate filesystem, network, game API, save, and cancellation
permission approval.

### Game save corruption

The current mock-only server does not read or write saves. A future real adapter
should prefer the game's supported API, introduce an explicit save-write
capability separate from ordinary actions, verify backup/restore procedures,
and add adapter-level transaction or confirmation rules where supported.
Dry-run output must never be treated as a backup.

### Safety stop cannot be trusted or is remotely reversed

Any active session with the explicit `safety.stop` capability may latch the
bridge. The local control plane can always stop independently of session/request
capacity and exposes the stopped state plus bounded in-flight count. Once
latched, new commit writes are denied while dry-run, describe, observation, and
session close remain available. `safety.resume` is not a request action. Local
resume is audited and denied while any write remains in flight; stop and denied
resume are audited as well. Read-only status is intentionally not audited.

The product operator channel is a separate Windows named pipe, not an MCP tool.
Its per-launch 32-byte token is discovered only through the fixed Local AppData
descriptor and compared at fixed length with a timing-safe primitive. The
protocol cannot carry a bridge request, path, executable, endpoint override, or
arbitrary action. A stale descriptor or listener collision prevents MCP
startup rather than degrading to TCP or serving without the brake.

This proves separation from the model/MCP request surface, not hostile same-user
isolation. On the tested Windows host, `Get-Acl` shows the application directory
and descriptor inherit the current profile's ordinary ACL entries; Node's
requested `0700`/`0600` modes are not evidence of a Windows user-exclusive ACL.
No custom DACL, integrity label, restricted token, or administrator boundary is
installed. Therefore malicious code running as the same OS user, and any
administrator, remains able to read or replace same-user runtime objects. The
implementation accurately targets only the stated local same-user boundary.
An ungraceful Windows process termination can leave a stale descriptor because
regular files are not kernel-owned pipe objects. A subsequent product start
fails closed and preserves it; it never guesses that an unmatched file is safe
to delete. Normal MCP EOF, transport-error, and server-close paths are bounded
and regression-tested to remove the exact launch object.

A valid resume request is not allowed to open the latch before its asynchronous
audit work and operator deadline succeed. The server aborts the bridge resume
on deadline or client disconnect; audit rejection and late settlement leave
`stopped=true`. Concurrent resume admission is singular and excess attempts are
denied as capacity. A later stop aborts every older pending resume transaction,
including a repeated stop that intentionally preserves `stopGeneration`. The
awaited event is explicitly a durable authorization for one exact generation,
not a claim that resume already completed. A success response is possible only
after that authorization is acknowledged and the still-live transaction commits
synchronously; no fire-and-forget success audit can be lost or remain pending.
A late authorization settlement is therefore not a false completion outcome.
This avoids a failure response paired with an already-open write gate or a
successful stop later being undone by older work.

The latch does not claim forced cancellation. An asynchronous action that
passed `beginWrite()` and entered the worker may complete after stop or client
disconnect; process termination is not proof a real game action rolled back.
The action remains visible and the
configured hard limit bounds how many can exist. A real adapter must decide
whether cooperative cancellation is safe for its game API.

MCP cancellation, EOF, or client disconnect also does not revoke a write permit
that already entered an adapter. It can abandon protocol delivery while the
adapter operation finishes and the handler gate releases afterward. Normal
test/client shutdown closes the client first and server/transport second.

### Capacity pressure blocks safety or closure

Local stop does not traverse a session cache. A full request cache permits
`session.close` to execute without adding another cache entry; the close state
transition is idempotent. Remote `safety.stop` remains an ordinary cached
request, so a caller under request-cache pressure must use the local control
plane. No unbounded tombstone or eviction path is introduced.

The operator connection cap also bounds application work rather than merely
counting accepted sessions. Overflow sockets are immediately destroyed and do
not allocate encoded failure responses, read timers, close timers, or an
application queue. Shutdown enumerates every admitted socket and clears its
tracked timers; a 64-contender flood regression proves the counters never rise
above the configured admission limit. Pending authenticated handlers are also
tracked: disconnect aborts their work, shutdown performs a bounded wait, and
destroyed/closing sockets are rejected before response encoding or timer
allocation. A pending-audit disconnect/shutdown regression releases the audit
late and proves all four public resource counters remain zero. Audit promises
have a separate tracked count; shutdown waits for audit idle within its fixed
deadline, and the regression proves the count remains visible until late
settlement and then returns to zero.

## Residual risks before a real adapter

- Sessions and the idempotency cache are process-local; a restart loses them.
- Client-spawned stdio has no remote authentication, encryption, origin binding,
  per-principal rate limiting, or distributed replay store and must not be
  exposed as a network service.
- The durable audit ledger detects ordinary corruption but is not tamper-proof
  against hostile same-user, administrator, or offline-disk rewriting. It has
  no automatic retention/deletion policy or external anchor.
- The mock worker has a kernel-enforced Restricted Token + Job boundary, but it
  is not a proven filesystem/network sandbox for hostile or real-game code.
- Capability grant 使用显式 fixed mock profile 和 fixed scope；stdio boundary
  仍是断言 local context 的可信组件。真实 adapter 尚无批准的 profile/resource
  discovery，test-only remote authorizer/grant 只证明 seam，不构成生产远程认证。
- `OUTCOME_UNKNOWN` 已阻止后续 commit，但尚无 durable operation journal、
  operation ID、reconciliation 或跨重启 replay 证据。
- Already-started adapter writes are not forcibly cancelled; real adapters may
  require cooperative cancellation semantics.
- The operator launch token and stop generation are process-local. The token is
  authentication only within the stated same-user boundary; the generation is
  concurrency/replay protection, not authentication or a durable replay store.

These are blockers for exposing a real game or remote endpoint, but they do not
block the offline mock foundation.
