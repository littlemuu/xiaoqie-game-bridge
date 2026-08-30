# xiaoqie-game-bridge

An offline-first, default-deny foundation for narrowly scoped game adapters,
with a client-spawned local stdio/MCP contract. The product server runs only a
deterministic mock world in a bounded child process: it does not start, inspect,
or control any real game or desktop application.

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
- A global safety latch blocks new commit writes. Its explicit in-process local
  control plane provides stop, status, and conservative resume; resume is
  refused while a bounded write is still in flight.
- Audit events contain hashed request/session tags and recursively redact common
  credential fields. Session events may contain a short caller tag derived by
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
entrypoint, which waits for MCP messages on stdin. It opens no port and creates
no listener, relay, tunnel, background service, or host configuration.

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
local safety status/resume control plane, and `safety.resume` remains unknown to
ordinary bridge requests.
