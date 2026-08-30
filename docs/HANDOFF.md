# Handoff

## Completed

- Node.js 22 + TypeScript project with strict compiler settings
- Versioned strict request/response protocol and stable error codes
- Memory-only, adapter-bound sessions with configurable 15-minute default TTL
  and 60-minute maximum, a 64-session hard limit, and deterministic terminal
  retention/sweep
- Separate observation and per-action capabilities
- Default-deny policy with strict adapter action schemas
- Per-session request idempotency, in-flight duplicate coalescing, and
  conflicting-ID rejection under a 256-entry hard limit
- Atomic global commit-write gate with a default maximum of four in-flight
  writes and reliable `finally` release
- Global safety latch plus non-routable local stop/status/resume control plane
- Injectable audit sink, hashed identifiers, and recursive credential redaction
- Deterministic in-memory mock adapter with movement and block placement
- Acceptance tests, deterministic demo, and Node 22 GitHub Actions workflow
- Architecture, threat model, handoff, and open-question documentation

## Conservative implementation choices

- No transport was added; callers use the in-process API.
- The default authorizer only opens sessions for explicit local request
  contexts; omitted caller context defaults to untrusted remote.
- Sessions and idempotency state are intentionally not persisted.
- Terminal retention is five minutes by default. Sweep is explicit and
  deterministic; session open invokes it, but no background timer exists.
- Request entries are not evicted. At capacity, an existing ID replays, a new
  ordinary request is refused, and `session.close` uses an idempotent bounded
  bypass without creating a tombstone.
- The safety latch is process-wide. Resume is absent from the request protocol
  and refused while any bounded write remains in flight.
- Game-action capabilities are granular (`game.act.move`,
  `game.act.place_block`) rather than one broad write grant.
- The mock adapter supports only `stone`, `dirt`, and `torch`, with a tiny fixed
  coordinate range.

## Verification

Run from the repository root with Node.js 22:

```bash
npm ci
npm run check
npm test
npm run demo
npm run build
git diff --check
```

Actual local results on 2026-08-30 with Node.js `v22.23.1` and npm `10.9.8`:

- `npm ci` — passed; 60 packages installed, 61 audited, 0 vulnerabilities
- `npm run check` — passed
- `npm test` — passed; 2 files and 20 tests, including 6 deterministic
  hardening tests
- `npm run demo` — passed; one idempotency hit, one committed move, safety-stop
  denial, and safe observation were demonstrated
- `npm run build` — passed
- `git diff --check` — passed

On this Windows managed host, Vitest and tsx needed to run outside the process
sandbox because their worker/esbuild child processes received `spawn EPERM`
inside it. No network, game, desktop application, or external file was accessed
by the tests or demo. GitHub-hosted CI status is recorded in the Draft PR.

## Known limits

- No real game, save, account, launcher, process, or file is accessed.
- No network transport, MCP server, tunnel, relay, listener, or remote auth is
  implemented.
- Audit and session state disappear on process exit.
- There is no rate limiter or adapter process isolation yet.
- Safety stop blocks new writes but does not forcibly cancel an asynchronous
  adapter action already in flight; real adapters may need cooperative
  cancellation.
- `session.open` idempotency is not persisted because it precedes creation of a
  session; session-scoped operations are idempotent as required.

## Suggested next smallest ticket

Build a **local-only stdio/MCP contract test** around `GameBridge.handle`, still
using only the mock adapter. It must preserve caller context and request IDs,
bound message size/concurrency, expose no remote resume, and create no listener,
tunnel, relay, or real-game integration.
