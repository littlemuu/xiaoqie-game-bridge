# Architecture

## Boundary map

```text
local MCP client (owns and spawns one child process)
                    |
                    | newline-delimited MCP over stdin/stdout
                    v
     stdio boundary: one tool, size/concurrency gates
                    |
                    | existing request envelope + fixed local context
                    v
              local GameBridge core
       protocol | session | policy | safety | audit
                    |
                    | adapter-bound, schema-validated calls
                    v
        GameAdapter interface -> mock-world adapter only
```

The client-spawned stdio process is the first protocol boundary. It creates no
listener, port, socket, tunnel, relay, firewall rule, background service,
account, or persistent credential. Stdio locality is not remote authentication;
any future network transport must supply a real authenticated context and must
not bypass the core.

## Core responsibilities

- `protocol.ts` owns the versioned, strict request and response contracts and
  stable error codes.
- `session.ts` owns memory-only, expiring, closeable, adapter-bound sessions,
  bounded per-session idempotency caches, and deterministic terminal cleanup.
- `policy.ts` default-denies unknown game actions, enforces action capability,
  and validates the adapter's strict input schema.
- `safety-latch.ts` owns a process-wide stop state and an atomic bounded-write
  gate. Stop/status/resume are available through an explicit in-process local
  control-plane object created by the bridge.
- `audit.ts` hashes request/session identifiers and recursively redacts common
  credential-shaped keys before an event reaches an injected sink.
- `bridge.ts` is the only orchestration path. It composes all checks before an
  adapter call and records both allowed and denied outcomes.
- `mcp/server.ts` owns the pure, bridge-injected MCP server factory, its single
  tool, deterministic response mapping, logical byte limit, and bounded handler
  gate.
- `mcp/stdio-server.ts` constructs only the mock registry and bridge, then uses
  the SDK's public stdio transport with a 64 KiB buffer. Stdout is reserved for
  MCP; its only diagnostics are fixed messages on stderr.

`OfflineLocalAuthorizer` allows session creation only for a local caller. The
`SessionAuthorizer` interface is the future identity/authentication seam. A
transport that accepts remote callers must inject a real authorizer; the core
does not implement an account database. Omitted caller context is treated as
untrusted remote, so forgetting to propagate context cannot silently gain local
session-opening authority.

## Why adapters stay separate

Minecraft and Stardew Valley expose different state models, mod APIs, failure
modes, and save-integrity risks. Putting those details in the core would make a
generic bridge accidentally inherit the broadest adapter's authority. Each
adapter therefore declares only its own observation capability, action names,
and strict input schemas. A session binds to one adapter, so a granted
capability cannot be redirected to another adapter.

The mock adapter is a proof of this boundary, not a placeholder shell: it has a
deterministic state, validates movement and block placement, previews changes
without mutation, and applies authorized commits in memory only.

## Request lifecycle

1. Strictly validate the versioned envelope; reject additional envelope fields.
2. Reject unknown bridge actions.
3. For session-scoped requests, resolve the bound session and reject it if it is
   closed or expired. Terminal sessions do not replay cached request IDs.
4. For an active session, replay an existing request ID if present, then enforce
   the request-cache hard limit. Reserve a new request ID with an in-flight
   promise before awaiting adapter completion. Concurrent identical requests
   await that same promise; conflicting content is rejected.
5. Reject adapter mismatches, missing capabilities, unknown game actions, and
   invalid action inputs.
6. For commit writes, synchronously check stop/write capacity and increment the
   global in-flight count in one `beginWrite()` operation. Dry-runs skip this
   gate and remain non-mutating.
7. Execute the adapter and release the in-flight count in `finally`, including
   known and unknown adapter failures.
8. Replace the in-flight entry with the completed response and record a
   sanitized audit event. Unknown action and unregistered adapter values are
   represented only by fixed categories and hashed tags.

`session.open` is necessarily the one pre-session lifecycle operation. In
`dry-run` mode it only describes the session that would be opened. A committed
session is created only after the adapter, requested capabilities, and injected
authorizer approve it.

## MCP boundary lifecycle

1. The SDK validates tool arguments directly with `requestEnvelopeSchema`.
   Undeclared envelope fields, including caller-supplied context or identity,
   are rejected before the handler and bridge.
2. The handler deterministically serializes the validated envelope and measures
   UTF-8 bytes. More than 32 KiB returns a fixed `RESOURCE_CAPACITY` result
   without entering the bridge.
3. A synchronous gate checks and increments the handler count. At the default
   limit of eight, a new call is rejected without a wait queue or bridge call.
4. The original envelope is passed unchanged to `GameBridge.handle` with the
   frozen server-owned `{ transport: "local" }` context. The wrapper creates no
   request ID and never retries.
5. The bridge result is checked with `responseEnvelopeSchema` and against the
   original request ID/action/mode/session. Invalid output or any exception is
   replaced by one fixed `INTERNAL_ERROR`; raw values and stacks never reach the
   protocol stream.
6. The sanitized response becomes complete `structuredContent`; deterministic
   JSON of that same response is the only text content. Bridge failures set MCP
   `isError: true` while preserving the stable bridge envelope and error code.
7. Handler capacity is released in `finally`, including errors, invalid output,
   and client-disconnect completion paths.

The MCP JSON-RPC ID belongs to the SDK transport. The bridge `requestId` lives
inside tool arguments and is the core idempotency key; the two are deliberately
not mapped to each other. A transport-level size/concurrency refusal never
enters the session request cache, so a later retry with the same bridge ID may
enter the core once capacity is available.

## Bounded lifetime and control-plane behavior

Defaults are 64 sessions, five minutes of terminal retention, 256 request
entries per session, and four concurrent commit writes. `SessionManager.sweep()`
uses the injected clock and removes only closed/expired sessions whose retention
deadline passed and which have no in-flight request. `open()` performs this
sweep before rejecting session capacity. It never evicts an active session.
Generated session IDs are checked before insertion; a collision fails closed
without replacing the retained session or exposing the colliding value.

Request entries are never evicted within a retained session. This preserves
successful commit evidence and in-flight promises. At capacity, new ordinary
requests receive `RESOURCE_CAPACITY` before adapter execution. An existing ID
still replays. A full cache cannot deadlock closure: `session.close` uses a
bounded exception that performs the idempotent close without adding a new cache
entry. Local stop is outside the request path and is always available.

The local control plane exposes `stopSafety()`, `getSafetyStatus()`, and
`resumeSafety()`. Status includes `stopped`, `inFlightWrites`, and the configured
maximum. Stop immediately blocks new commits but does not cancel work already
inside an adapter. Resume is denied until the count reaches zero. Stop and
resume attempts are audited; status is a read-only snapshot and is not audited.
That control-plane object is not returned to or callable from MCP. Cancellation,
EOF, or client disconnect closes protocol work but is not evidence that an
adapter write already past `beginWrite()` was forcibly cancelled.

## Deliberately absent

- Network servers, HTTP/WebSocket/SSE endpoints, tunnels, relays, ports, and
  remote authentication
- Shell/PowerShell, arbitrary process execution, filesystem access, input
  simulation, or generic desktop automation
- Real games, launchers, accounts, saves, purchased content, host MCP
  configuration, or secrets
- Persistent sessions or bearer-token storage
- Cloud-side personality or long-term memory
