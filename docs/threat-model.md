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

The current process has session expiry and a global safety latch, but it does
not yet implement quotas or rate limits. A future transport must add bounded
concurrency and per-session/per-action rate limits before any real adapter is
enabled. Closed/expired sessions and request-cache entries also lack pruning and
capacity limits, so a long-lived process can accumulate memory. The safety stop
remains below the future transport layer.

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
bridge. Once latched, game writes are denied while describe, observation, and
session close remain available. `safety.resume` is not a request action. Resume
exists only on an explicit in-process local control-plane object and is audited.
A production host should attach this to a user-controlled local interface.
The current latch prevents new writes from entering an adapter; it does not
cancel an asynchronous action already in flight. The local control-plane object
also exposes resume only. Both limitations must be resolved or explicitly
bounded before a transport or real adapter is enabled.

## Residual risks before a real adapter

- Sessions and the idempotency cache are process-local; a restart loses them.
- Session and request-cache entries have no cleanup or capacity policy yet.
- No transport authentication, encryption, origin binding, rate limiting, or
  distributed replay store exists yet.
- The in-memory audit sink is demonstrative, not durable or tamper-evident.
- A future adapter runs in-process unless an isolation boundary is added.
- Capability grants are approved by a simple local-only authorizer in phase 1.

These are blockers for exposing a real game or remote endpoint, but they do not
block the offline mock foundation.
