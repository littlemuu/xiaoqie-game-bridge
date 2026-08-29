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
- `session.ts` owns memory-only, expiring, closeable, adapter-bound sessions and
  their per-session idempotency cache.
- `policy.ts` default-denies unknown game actions, enforces action capability,
  and validates the adapter's strict input schema.
- `safety-latch.ts` owns a process-wide stop state. Resume is only available
  through an explicit in-process control-plane object created by the bridge.
- `audit.ts` hashes request/session identifiers and recursively redacts common
  credential-shaped keys before an event reaches an injected sink.
- `bridge.ts` is the only orchestration path. It composes all checks before an
  adapter call and records both allowed and denied outcomes.

`OfflineLocalAuthorizer` allows session creation only for a local caller. The
`SessionAuthorizer` interface is the future identity/authentication seam. A
transport that accepts remote callers must inject a real authorizer; the core
does not implement an account database.

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
3. For session-scoped requests, resolve the bound session and consult its
   idempotency cache before any side effect.
4. Reject closed/expired sessions, adapter mismatches, missing capabilities,
   unknown game actions, and invalid action inputs.
5. Reject game writes while the safety latch is stopped.
6. Execute the adapter in `dry-run` or `commit` mode.
7. Cache the response by request ID and record a sanitized audit event.

`session.open` is necessarily the one pre-session lifecycle operation. In
`dry-run` mode it only describes the session that would be opened. A committed
session is created only after the adapter, requested capabilities, and injected
authorizer approve it.

## Deliberately absent

- Network servers, public endpoints, tunnels, relay clients, and MCP transport
- Shell/PowerShell, arbitrary process execution, filesystem access, input
  simulation, or generic desktop automation
- Real games, launchers, accounts, saves, purchased content, or secrets
- Persistent sessions or bearer-token storage
- Cloud-side personality or long-term memory
