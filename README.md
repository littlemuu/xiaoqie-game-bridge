# xiaoqie-game-bridge

An offline-first, default-deny foundation for narrowly scoped game adapters,
with a client-spawned local stdio/MCP contract and a separate same-user Windows
named-pipe operator channel. The product server runs only a deterministic mock
world in a bounded child process: it does not start, inspect, or control any
real game or desktop application. Its bridge/operator security events use a
separate bounded local audit ledger; that ledger is not a game save.

## Requirements

- Node.js 22
- npm 10 or newer

## Five-minute verification

```bash
npm ci
npm run check
npm test
npm run demo
npm run build
npm audit
git diff --check
```

The demo opens an in-memory session, previews a movement, commits it once,
replays the same request without a second side effect, triggers the safety
latch, and proves that observation remains available while writes are denied.

## Safety properties

- Unknown bridge actions and undeclared parameters are rejected.
- Sessions are memory-only, adapter-bound, capability-limited, caller-bound,
  and expire. A session opened by one trusted caller cannot be observed,
  replayed, stopped, or closed by another caller.
- Session count, per-session request history, and concurrent commit writes have
  hard limits. Capacity exhaustion returns `RESOURCE_CAPACITY` before adapter
  side effects.
- Every mock-game mutation supports a non-mutating `dry-run` mode.
- Reusing a request ID cannot repeat an operation; conflicting reuse is denied.
- A global safety latch blocks new commit writes. Each running-to-stopped edge
  increments a monotonic `stopGeneration`; resume requires that exact observed
  generation and zero in-flight writes.
- Product audit events survive clean restart in a fixed append-only local
  ledger. They contain hashed request/session tags and recursively redact common
  credential, path, endpoint, PID, username, stack, and raw-payload fields.
  Session events may contain a short caller tag derived by
  HMAC with a process-memory-only random key, never the caller principal, full
  owner digest, or HMAC key.
- The product server exposes no shell, generic process, filesystem, network,
  keyboard, mouse, tunnel, or real-game capability. The dev-only official MCP
  client starts exactly the built stdio server in contract tests.

See [architecture](docs/architecture.md), [threat model](docs/threat-model.md),
[handoff](docs/HANDOFF.md), and [open questions](docs/OPEN_QUESTIONS.md).

## Isolated mock adapter process

The product stdio entrypoint registers `ProcessMockAdapter`. It launches one
fixed built `mock-worker.js` with `process.execPath`, fixed argv/cwd, `shell:
false`, hidden windows, pipe-only stdio, and an explicit minimal parent-supplied
environment. Requests cannot select an executable, path, argument, environment,
or adapter identity. The pure in-memory mock remains the worker implementation
and a unit-test fixture only.

Adapter IPC is newline-delimited, versioned, strict JSON with a 64 KiB frame
limit, 32 KiB logical-message limit, eight pending calls, two-second handshake
and call deadlines, and a one-second graceful-close deadline. Parent-generated
`call-N` identifiers are unrelated to MCP, bridge request, session, or caller
identity. Malformed/unknown/oversized output, wrong or duplicate IDs, timeout,
EOF, crash, and non-zero exit fail closed and settle pending calls with fixed
sanitized bridge errors.

This is fault containment between trusted components running as the same OS
user, not a proven OS sandbox. The worker remains trusted code requiring
separate review. It receives no caller context, principal, session/owner data,
caller-tag key, credential, or host secret. No real adapter is authorized.

## Capacity defaults and configuration

The defaults are intentionally finite:

- 64 retained sessions
- 5-minute terminal-session retention
- 256 idempotency entries per session
- 4 concurrent commit writes across the bridge
- 4 KiB per audit record, 8 pending audit writes, 64 KiB per segment,
  8 segments total, and a 500 ms ledger shutdown-drain deadline

Configure the first three through `SessionManagerOptions` (`maxSessions`,
`terminalRetentionMs`, and `maxRequestsPerSession`). Configure the write gate
with `new SafetyLatch({ maxInFlightWrites })`. `SessionManager.sweep()` uses the
injected clock and creates no timer; `open()` also sweeps eligible terminal
sessions before checking capacity. Active sessions and sessions with in-flight
requests are never evicted.

When a request cache is full, an existing request ID still replays its original
response, while a new ordinary request is rejected. `session.close` may bypass
the full cache without adding an entry; closing is itself idempotent. Local
`stopSafety()` does not use a session request cache and therefore cannot be
locked out by request capacity.

## Local stdio/MCP contract

After `npm run build`, a local MCP client may spawn the server with Node at
`dist/src/mcp/stdio-server.js`. `npm run mcp:stdio` invokes that same built
entrypoint, which first opens and verifies the fixed local audit ledger, then
creates the local operator named-pipe listener, and only then waits for MCP
messages on stdin. Ledger or operator startup failure exits closed. It opens no TCP/HTTP port and creates no relay,
tunnel, background service, or host configuration.

The MCP surface registers exactly one tool, `game_bridge_request`. Its input and
structured output reuse `requestEnvelopeSchema` and `responseEnvelopeSchema`;
there is no parallel protocol schema. The tool may carry a commit request, so
its metadata is deliberately not read-only or inherently idempotent. It is
closed-world and reaches only the in-memory mock adapter.

The boundary fixes caller context to a frozen `{ transport: "local" }` inside
trusted server code. Tool arguments cannot self-declare context, principal, or
transport identity. MCP's JSON-RPC request ID and the envelope's bridge
`requestId` are separate: the wrapper preserves the latter byte-for-byte,
generates no replacement ID, and performs no automatic retry.

At the core boundary, caller context is captured once from own data-property
descriptors, strict-validated from those captured values, copied, and deeply
frozen before the first asynchronous authorization step. Local
context has exactly one field. A future remote transport must provide exactly
`transport`, `principal.subject`, and `principal.method`; both principal fields
are non-empty and bounded. Omitted, malformed, or extended context is
untrusted. Remote transport and authentication are still deliberately absent.
The local owner domain is process-local in effect because sessions are neither
persisted nor shared between processes.

Stdio has a 64 KiB frame-buffer limit. Valid tool arguments face a second,
deterministically measured 32 KiB UTF-8 envelope limit, and at most eight tool
handlers enter the bridge concurrently. Logical-size or handler-capacity
refusals occur before core/adapter execution and return `RESOURCE_CAPACITY`;
they are transport results, not entries in the core idempotency cache. Stdout is
protocol-only. Transport diagnostics, when necessary, are fixed and sanitized
on stderr.

The logical limit is configurable through the factory's `maxEnvelopeBytes` and
the handler limit through `maxConcurrentHandlers`; production uses the exported
defaults. Tests may inject a `HandlerConcurrencyGate` directly to inspect permit
release without introducing timers.

Client cancellation or disconnect closes the transport but does not claim to
forcibly cancel or roll back a write that already entered the core or worker. The client
must close first, followed by the server/transport. The MCP surface exposes no
operator identity or local safety status/resume surface, and `safety.resume`
remains unknown to ordinary bridge requests.

## Durable local audit ledger

Production stores only the bridge/operator's bounded safety events under the
fixed current-user application directory
`AppData/Local/xiaoqie-game-bridge-audit/ledger`. No MCP request, bridge
parameter, adapter, operator command, CLI option, or application-specific
environment setting can select a path, file name, format, rotation rule, or
capacity. The operator's ephemeral descriptor remains in the separate
`xiaoqie-game-bridge` runtime directory and is still removed on normal exit;
ledger segments are not removed or truncated.

Each closed-world version-1 record has an eight-hex-byte length prefix, a
canonical JSON payload, newline frame terminator, monotonic sequence, previous
record digest, and its own SHA-256 digest. A successful `AuditSink.write()`
means the complete frame was appended and Node's `FileHandle.sync()` resolved.
This is the strongest acknowledgement used here, but it does not bypass OS or
device caches and is not a guarantee for every power-loss model.

On startup, every owned segment, frame, schema, sequence, and digest link is
validated before operator or MCP commits are admitted. A recognizable partial
final frame is preserved in place; startup moves to the next fixed segment and
syncs one bounded recovery marker. Reopening that history is idempotent.
Unknown versions, committed-region corruption, illegal sizes/order, unexpected
objects, and identity changes fail startup closed without rewriting evidence.
At the eight-segment hard limit, history is not evicted: new ordinary commits
and resume fail closed. Emergency stop still closes the latch first and only
then attempts audit, so audit rejection/full state can fail the command result
but cannot return the latch to running.

The chain detects ordinary torn writes, internal truncation, reordering, and
accidental corruption inside the trusted same-user boundary. With no protected
key or external anchor it is not tamper-proof against hostile same-user code,
administrators, or offline disk rewriting. The ledger contains no game state,
observations, inputs/outputs, chat, account, save, screen, or persistent bearer
secret, and there is no MCP/CLI log reader or arbitrary file API.

## Local operator CLI (Windows)

The same product process publishes a per-launch descriptor under the fixed
application directory in the current user's Local AppData and listens on a
random Windows named pipe. MCP serving begins only after that control plane is
ready; descriptor or listener failure exits closed before any MCP commit can be
accepted. The descriptor contains a 32-byte CSPRNG launch token, is strict and
bounded, and is removed only after file identity and digest still match the
object created by that launch.

After `npm run build`, use a second local terminal while the stdio product is
running:

```text
npm run operator -- status
npm run operator -- stop
npm run operator -- resume --generation 1
```

The CLI accepts no endpoint, path, host, port, URL, executable, or environment
override. It emits one fixed result and deterministic exit code. `status` is
read-only and unaudited; stop and resume attempts use the same bridge audit
sink as MCP. Stop bypasses sessions, the request cache, MCP
handler permits, and adapter pending capacity. It blocks only new commits and
does not claim to cancel or roll back an action already inside the adapter.

The channel separates operator authority from the MCP/model surface, but it is
not remote authentication and does not defend against malicious code already
running as the same OS user or as administrator. No TCP fallback exists.

Resume is transactional with respect to the operator deadline: the latch stays
stopped while an explicitly named authorization audit event is pending. That
event durably authorizes one exact stop generation but does not claim the latch
already opened; only after its sink acknowledgement, while the transaction is
still live, does the bridge synchronously commit and return success. There is no
fire-and-forget success outcome. Audit rejection, operator timeout, client
disconnect, or a late authorization continuation cannot open the latch. Every
later stop invalidates an older pending resume even when the repeated stop keeps
the same public generation. Connections beyond the fixed admission limit are
destroyed immediately without allocating a response frame or close timer, and
late handlers cannot add response work after disconnect or shutdown. Every
audit-sink promise is tracked; operator shutdown performs a bounded audit-idle
wait, including authorization writes that outlive a disconnected request.

CI has two explicit acceptance paths. Ubuntu runs the platform-neutral core and
skips only Windows product-child/operator cases; `windows-latest` runs the full
suite including real named pipes, the built CLI, and the built stdio child.
