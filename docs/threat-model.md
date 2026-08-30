# Threat model

## Assets and trust boundaries

The protected assets are the user's future game process and saves, local
credentials, the integrity of allowed game actions, and the ability to stop the
bridge. Cloud reasoning and future transports are not implicitly trusted to
perform arbitrary local work. The local bridge core remains the enforcement
boundary, and adapters are treated as separately reviewable capability modules.

Phase 1 touches none of those real assets. Its only mutable asset is an
in-memory mock world.

## Threats and current controls

### Prompt injection requests broader authority

A model, game text, or untrusted document could instruct a future transport to
run a command or call an undeclared action. The envelope is strict, bridge
actions are enumerated, policy is default-deny, and every adapter action has a
strict schema and explicit capability. There is no generic command, process,
filesystem, network, keyboard, or mouse primitive to invoke.

### Token disclosure and replay

Sessions are memory-only. Audit events store truncated SHA-256 tags instead of
raw request/session identifiers. Attacker-controlled unknown actions and
unregistered adapter IDs are also reduced to fixed categories plus hashed tags.
Structured metadata recursively redacts keys such as token, password, secret,
authorization, cookie, credential, and API key. Future
transports must keep bearer credentials outside request params, authenticate
before opening a session, encrypt transport traffic, and bound token lifetime.

Replay within a session is handled by a request-ID cache. The first request
installs an in-flight promise before adapter completion; concurrent or later
identical replays await or return the same response without executing again.
Reusing the ID for different content returns `REQUEST_ID_REUSED`.

### Duplicate or ambiguous actions

Per-session idempotency covers allowed and denied session-scoped requests. A
request fingerprint uses deterministic key ordering. Future distributed
transports must preserve the request ID and must not generate a fresh ID when
automatically retrying a write.

### Runaway loops and excessive call rate

The core has finite session count, per-session request history, and concurrent
commit-write limits. Session open sweeps eligible terminal state before a
stable capacity refusal. Request capacity never evicts in-flight or completed
commit evidence; new requests are refused before adapter execution. A future
transport must still add message-size, per-principal, and per-action rate limits.

### Adapter exceeds its authority

Sessions bind to exactly one adapter. Policy uses only that adapter's registered
actions and schemas. Capability names are checked both when the session opens
and when the action executes. A real adapter still requires code review and
adapter-specific sandboxing because TypeScript interfaces alone cannot contain
malicious implementation code.

### Game save corruption

Phase 1 does not read or write saves. A future real adapter should prefer the
game's supported API, introduce an explicit save-write capability separate from
ordinary actions, verify backup/restore procedures, and add adapter-level
transaction or confirmation rules where supported. Dry-run output must never be
treated as a backup.

### Safety stop cannot be trusted or is remotely reversed

Any active session with the explicit `safety.stop` capability may latch the
bridge. The local control plane can always stop independently of session/request
capacity and exposes the stopped state plus bounded in-flight count. Once
latched, new commit writes are denied while dry-run, describe, observation, and
session close remain available. `safety.resume` is not a request action. Local
resume is audited and denied while any write remains in flight; stop and denied
resume are audited as well. Read-only status is intentionally not audited.

The latch does not claim forced cancellation. An asynchronous action that
passed `beginWrite()` may complete after stop, but it remains visible and the
configured hard limit bounds how many can exist. A real adapter must decide
whether cooperative cancellation is safe for its game API.

### Capacity pressure blocks safety or closure

Local stop does not traverse a session cache. A full request cache permits
`session.close` to execute without adding another cache entry; the close state
transition is idempotent. Remote `safety.stop` remains an ordinary cached
request, so a caller under request-cache pressure must use the local control
plane. No unbounded tombstone or eviction path is introduced.

## Residual risks before a real adapter

- Sessions and the idempotency cache are process-local; a restart loses them.
- No transport authentication, encryption, origin binding, rate limiting, or
  distributed replay store exists yet.
- The in-memory audit sink is demonstrative, not durable or tamper-evident.
- A future adapter runs in-process unless an isolation boundary is added.
- Capability grants are approved by a simple local-only authorizer in phase 1.
- Already-started adapter writes are not forcibly cancelled; real adapters may
  require cooperative cancellation semantics.

These are blockers for exposing a real game or remote endpoint, but they do not
block the offline mock foundation.
