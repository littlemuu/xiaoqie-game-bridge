# Architecture

## Boundary map

```text
Cloud chat / Cloud Work (reasoning, personality, long-term memory)
                    |
                    | future authenticated, rate-limited transport
                    v
        transport adapter (not implemented in phase 1)
                    |
                    | versioned request envelope + caller context
                    v
              local GameBridge core
       protocol | session | policy | safety | audit
                    |
                    | adapter-bound, schema-validated calls
                    v
        GameAdapter interface -> mock-world adapter
                              -> future Minecraft adapter
                              -> future Stardew/SMAPI adapter
```

Phase 1 ends at an in-process TypeScript API. It creates no listener, tunnel,
relay, firewall rule, background service, account, or persistent credential.
A future stdio, loopback HTTP, MCP, or relay transport must translate its input
to `GameBridge.handle` and supply an authenticated `RequestContext`; it must not
bypass the core.

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
3. For session-scoped requests, resolve the bound session, replay an existing
   ID if present, then enforce the request-cache hard limit. Reserve a new
   request ID with an in-flight promise before awaiting adapter completion.
   Concurrent identical requests await that same promise; conflicting content
   is rejected.
4. Reject closed/expired sessions, adapter mismatches, missing capabilities,
   unknown game actions, and invalid action inputs.
5. For commit writes, synchronously check stop/write capacity and increment the
   global in-flight count in one `beginWrite()` operation. Dry-runs skip this
   gate and remain non-mutating.
6. Execute the adapter and release the in-flight count in `finally`, including
   known and unknown adapter failures.
7. Replace the in-flight entry with the completed response and record a
   sanitized audit event. Unknown action and unregistered adapter values are
   represented only by fixed categories and hashed tags.

`session.open` is necessarily the one pre-session lifecycle operation. In
`dry-run` mode it only describes the session that would be opened. A committed
session is created only after the adapter, requested capabilities, and injected
authorizer approve it.

## Bounded lifetime and control-plane behavior

Defaults are 64 sessions, five minutes of terminal retention, 256 request
entries per session, and four concurrent commit writes. `SessionManager.sweep()`
uses the injected clock and removes only closed/expired sessions whose retention
deadline passed and which have no in-flight request. `open()` performs this
sweep before rejecting session capacity. It never evicts an active session.

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

## Deliberately absent

- Network servers, public endpoints, tunnels, relay clients, and MCP transport
- Shell/PowerShell, arbitrary process execution, filesystem access, input
  simulation, or generic desktop automation
- Real games, launchers, accounts, saves, purchased content, or secrets
- Persistent sessions or bearer-token storage
- Cloud-side personality or long-term memory
