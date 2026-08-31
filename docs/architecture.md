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
                    | bounded versioned adapter IPC
                    v
 ProcessMockAdapter -> fixed Node child -> mock-world only

separate local operator CLI
                    |
                    | strict authenticated Windows named-pipe frames
                    v
 operator server -> same bridge local control -> same safety latch + audit sink
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
  immutable caller-owner bindings, bounded per-session idempotency caches, and
  deterministic terminal cleanup.
- `request-context.ts` synchronously validates and snapshots trusted caller
  context, then derives domain-separated, length-prefixed SHA-256 owner keys
  and keyed, domain-separated short audit tags.
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
- `runtime/product-runtime.ts` constructs the registry, process mock, bridge,
  safety latch, audit sink, and local control object exactly once.
- `operator/protocol.ts`, `operator/server.ts`, and `operator/client.ts` own the
  closed-world operator contract, named-pipe listener, fixed descriptor, and
  narrow CLI client.
- `mcp/stdio-server.ts` starts the operator server before the SDK's public stdio
  transport. Stdout is reserved for MCP; diagnostics are fixed messages on
  stderr.
- `adapters/mock/adapter-ipc.ts` is the single strict IPC contract and owns
  message/frame limits, fixed identity, internal call IDs, and lifecycle defaults.
- `adapters/mock/process-mock-adapter.ts` owns fixed spawn configuration,
  deadlines, bounded pending state, response correlation, and failure settlement.
- `adapters/mock/mock-worker.ts` is the fixed built child. It owns only the
  deterministic in-memory mock state and executes already-authorized calls.

`OfflineLocalAuthorizer` allows session creation only for a local caller. The
`SessionAuthorizer` interface is the future identity/authentication seam. A
transport that accepts remote callers must inject a real authorizer; the core
does not implement an account database. Omitted caller context is treated as
untrusted, so forgetting to propagate context cannot silently gain local
session-opening or session-use authority. Context is not part of a request
envelope or MCP arguments.

Trusted local context is exactly `{ transport: "local" }`. Trusted remote
context is exactly `{ transport: "remote", principal: { subject, method } }`;
both nested strings are non-empty and bounded, and additional properties are
rejected. The bridge captures each own data-property descriptor value once,
validates and copies only that captured graph, and deeply freezes the result
before its first `await`; it never rereads the caller object after validation.
Sessions store only the derived full owner digest,
not raw principal data. The local owner is a fixed process-local domain; since
sessions are not persisted or shared, it conveys no cross-process authority.

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

## Adapter process lifecycle

The parent statically declares mock identity, capabilities, actions, and input
schemas. Worker `ready` must exactly match and cannot add authority. The parent
generates internal `call-N` IDs only after bridge policy and safety checks; no
bridge/MCP request ID, session ID, caller context, principal, owner digest, or
audit HMAC key crosses IPC. Dry-run remains explicit and non-mutating.

The executable is `process.execPath`; the sole argv and cwd are derived from the
fixed built module path. `shell` is false, stdio is pipe/pipe/ignored, and the
supplied environment contains only a fixed worker marker (plus isolated fixture
mode in tests). Windows may materialize OS-required environment entries, but a
credential-shaped parent sentinel is proven absent from the real child.

At most eight calls are pending and there is no application wait queue. Strict
64 KiB frame and 32 KiB message limits apply. Malformed JSON, unknown
fields/types, oversized output, identity mismatch, wrong/duplicate/late call
ID, backpressure, timeout, EOF, crash, or non-zero exit fail closed, settle every
pending promise once, release timers/capacity, and terminate the child. Normal
close waits for shutdown acknowledgement and zero exit; close with pending work
settles that work before termination.

This is a same-OS-user process boundary, not a proven OS sandbox. The worker is
trusted and separately reviewable code.

## Request lifecycle

1. Strictly validate the versioned envelope; reject additional envelope fields.
2. Synchronously validate, copy, and freeze the out-of-band caller context;
   reject unknown bridge actions. `bridge.describe` remains context-free.
3. For session-scoped requests, resolve the bound session and compare its
   immutable owner key before checking active state, cache, capability, adapter,
   world, or safety state. Untrusted or different callers receive the same
   `AUTHORIZATION_DENIED` and cannot read or join another owner's cache.
4. Reject an owner-matched session if it is closed or expired. Terminal
   sessions do not replay cached request IDs.
5. For an active session, replay an existing request ID if present, then enforce
   the request-cache hard limit. Reserve a new request ID with an in-flight
   promise before awaiting adapter completion. Concurrent identical requests
   await that same promise; conflicting content is rejected.
6. Reject adapter mismatches, missing capabilities, unknown game actions, and
   invalid action inputs.
7. For commit writes, synchronously check stop/write capacity and increment the
   global in-flight count in one `beginWrite()` operation. Dry-runs skip this
   gate and remain non-mutating.
8. Execute the adapter and release the in-flight count in `finally`, including
   known and unknown adapter failures.
9. Replace the in-flight entry with the completed response and record a
   sanitized audit event. Unknown action and unregistered adapter values are
   represented only by fixed categories and hashed tags. Valid session calls
   and cross-owner denials carry only a short caller tag derived with HMAC-SHA-256.

The caller-tag HMAC uses a 32-byte process-memory-only random key. A bridge may
receive a copied fixed key for deterministic tests, but the default key is
generated at module initialization. It is never placed in a session, response,
audit event, demo, or transport payload. This prevents an audit observer from
testing low-entropy subject/method candidates with the public owner derivation.

`session.open` is necessarily the one pre-session lifecycle operation. In
`dry-run` mode it only describes the session that would be opened. A committed
session is created only after the adapter, requested capabilities, and injected
authorizer approve it, and `SessionManager.open` requires the caller owner key
explicitly. Dry-run creates neither session nor owner state.

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
`resumeSafety(generation)`. Status includes `stopped`, `inFlightWrites`, the
configured maximum, and `stopGeneration`. A running-to-stopped edge increments
the generation; repeated stop does not. Stop immediately blocks new commits but
does not cancel work already inside an adapter. Resume requires the exact
current generation and zero in-flight writes. Stop and resume attempts are
audited; status is a read-only snapshot and is not audited. Every stop also
invalidates any older local resume transaction without changing the public
generation rule for repeated stops.
That control-plane object is not returned to or callable from MCP. Cancellation,
EOF, or client disconnect closes protocol work but is not evidence that an
adapter write already past `beginWrite()` was forcibly cancelled.

## Operator startup, protocol, and shutdown

`createProductRuntime()` is the single construction seam. The stdio entrypoint
starts `LocalOperatorServer` with that runtime's control object before calling
`serveStdio`; any runtime-directory, descriptor, or listener failure writes one
fixed stderr category and returns without accepting MCP. Shutdown first starts
closing MCP, then closes operator connections/listener and the adapter with
bounded waits, and finally waits briefly for MCP transport completion. A
process-exit fallback performs the same identity-checked descriptor cleanup
synchronously.

Production supports Windows named pipes only. Each launch uses a random
32-hex-suffix endpoint and a random 32-byte base64url token. A strict descriptor
is atomically installed without replacement at a fixed Local AppData path. The
server compares the fixed-length decoded token with `timingSafeEqual`. Frames
are newline-delimited, limited to 4 KiB framing and 2 KiB logical JSON, allow
one request/response only, and use strict versioned schemas. Four connections
and finite listen/read/handler/close deadlines bound work; no queue or TCP
fallback exists.

Only admitted sockets receive read, handler, response, and close timers.
Connections beyond the admission limit are destroyed immediately and are not
placed in a rejection queue. Read-only resource counters expose tracked
connections and timer/response work for bounded shutdown regression tests.
Authenticated handlers are tracked separately; disconnect aborts their control
operation, shutdown waits for their bounded settlement, and a destroyed socket
or closing server cannot allocate late response work. The bridge also tracks
every audit-sink promise. Operator shutdown performs a second bounded wait for
audit idle, so a disconnected request's still-pending authorization remains
observable and cannot become unowned background work.

The CLI can issue only `status`, `stop`, or `resume --generation <n>`. Endpoint
and token are read from the fixed descriptor and cannot be selected by CLI,
MCP, bridge params, or environment. Malformed, unknown, repeated, coalesced,
oversized, unauthenticated, late, or disconnected traffic produces fixed
failure categories and never enters the bridge action protocol.

Resume uses an abort-aware two-phase path. The bridge first verifies generation,
stopped state, in-flight writes, and single-resume admission while leaving the
latch closed. It waits for a `safety.resume.authorization.local` audit event
whose metadata names `phase=authorization` and the exact authorized generation.
The event is the durable authority for that one transaction, not a claim that
the latch already opened. Only sink acknowledgement within the operator handler
deadline permits the synchronous `SafetyLatch.resume()` and success response;
there is no untracked post-commit audit promise. Deadline expiry, socket
disconnect, or a later stop aborts the transaction, and audit rejection or a
late settlement cannot run the commit continuation.

## Deliberately absent

- Network servers, HTTP/WebSocket/SSE endpoints, tunnels, relays, ports, and
  remote authentication
- Shell/PowerShell, arbitrary process execution, filesystem access, input
  simulation, or generic desktop automation
- Real games, launchers, accounts, saves, purchased content, host MCP
  configuration, or secrets
- Persistent sessions or bearer-token storage
- General process execution or caller-selectable worker paths/arguments
- Cloud-side personality or long-term memory
