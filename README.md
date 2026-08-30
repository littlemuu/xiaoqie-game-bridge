# xiaoqie-game-bridge

An offline-first, default-deny foundation for narrowly scoped game adapters.
This phase uses only a deterministic in-memory mock world: it does not start,
inspect, or control any real game or desktop application.

## Requirements

- Node.js 22
- npm 10 or newer

## Five-minute verification

```bash
npm ci
npm run check
npm test
npm run demo
```

The demo opens an in-memory session, previews a movement, commits it once,
replays the same request without a second side effect, triggers the safety
latch, and proves that observation remains available while writes are denied.

## Safety properties

- Unknown bridge actions and undeclared parameters are rejected.
- Sessions are memory-only, adapter-bound, capability-limited, and expire.
- Session count, per-session request history, and concurrent commit writes have
  hard limits. Capacity exhaustion returns `RESOURCE_CAPACITY` before adapter
  side effects.
- Every mock-game mutation supports a non-mutating `dry-run` mode.
- Reusing a request ID cannot repeat an operation; conflicting reuse is denied.
- A global safety latch blocks new commit writes. Its explicit in-process local
  control plane provides stop, status, and conservative resume; resume is
  refused while a bounded write is still in flight.
- Audit events contain hashed request/session tags and recursively redact common
  credential fields.
- There is no shell, process, filesystem, network, keyboard, mouse, tunnel, or
  real-game capability in this repository.

See [architecture](docs/architecture.md), [threat model](docs/threat-model.md),
[handoff](docs/HANDOFF.md), and [open questions](docs/OPEN_QUESTIONS.md).

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
