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
- Every mock-game mutation supports a non-mutating `dry-run` mode.
- Reusing a request ID cannot repeat an operation; conflicting reuse is denied.
- A global safety latch blocks state changes and can only be resumed through an
  explicit in-process local control-plane API.
- Audit events contain hashed request/session tags and recursively redact common
  credential fields.
- There is no shell, process, filesystem, network, keyboard, mouse, tunnel, or
  real-game capability in this repository.

See [architecture](docs/architecture.md), [threat model](docs/threat-model.md),
[handoff](docs/HANDOFF.md), and [open questions](docs/OPEN_QUESTIONS.md).
